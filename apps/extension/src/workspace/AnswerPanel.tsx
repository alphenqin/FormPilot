import { useEffect, useRef, useState } from 'react';
import {
  canonicalJson,
  hashJson,
  type CareerState,
  type AnswerRequest,
  type AnswerPending,
} from '@formpilot/contracts';
import {
  eligibleAnswerFacts,
  makeAnswerInput,
  acceptAnswer,
  putAnswer,
  reviseAnswer,
  isAnswerCurrent,
  exportAnswer,
  emptyCareer,
  resumeFactLabels,
  answerFactValue,
  displayValue,
  type ProfileState,
} from '@formpilot/domain';
import * as api from './api';
interface Props {
  profile: ProfileState;
  session: api.ApiSession | null;
  fresh: () => Promise<ProfileState>;
  updateCareer: (
    fn: (c: CareerState, p: ProfileState) => CareerState,
  ) => Promise<ProfileState>;
}
export function AnswerPanel(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const alive = useRef(true),
    active = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const career = props.profile.career ?? emptyCareer();
  const [jobId, setJobId] = useState(career.jobs.at(-1)?.job_id ?? ''),
    [answerId, setAnswerId] = useState('');
  const [question, setQuestion] = useState(''),
    [selected, setSelected] = useState<string[]>([]),
    [consent, setConsent] = useState(false);
  const cancelled = useRef(new Set<string>());
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [caps, setCaps] = useState<Awaited<
    ReturnType<typeof api.capabilities>
  > | null>(null);
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(
    null,
  );
  const job =
    career.jobs.find((j) => j.job_id === jobId) ?? career.jobs.at(-1) ?? null;
  const facts = eligibleAnswerFacts(props.profile),
    chosen = selected.filter((id) => facts.some((f) => f.fact_id === id));
  const answers = (career.answers ?? []).filter(
    (a) => a.input.job.job_id === job?.job_id,
  );
  const answer =
    answers.find((a) => a.answer_id === answerId) ?? answers.at(-1) ?? null;
  const editorKey = answer ? answer.answer_id + ':' + answer.revision : '';
  const text = editing?.key === editorKey ? editing.text : (answer?.text ?? '');
  const dirty = !!answer && text !== answer.text;
  const stale = !!answer && !isAnswerCurrent(answer, job, props.profile);
  let preview: ReturnType<typeof makeAnswerInput> | null = null;
  try {
    if (job && question.trim() && chosen.length && chosen.length <= 16)
      preview = makeAnswerInput(job, props.profile, question, chosen);
  } catch {
    /* Show validated input only. */
  }
  const selectionKey = canonicalJson(chosen);
  useEffect(() => {
    setConsent(false);
  }, [
    question,
    job?.job_id,
    job?.revision,
    selectionKey,
    props.profile.profile_revision,
    caps?.provider,
    caps?.model,
  ]);
  useEffect(() => {
    let cancelled = false;
    void api
      .capabilities()
      .then((c) => {
        if (!cancelled) setCaps(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [props.session]);
  async function work(fn: () => Promise<void>) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (e) {
      if (alive.current)
        setMessage(e instanceof Error ? e.message : '开放题操作未完成');
    } finally {
      active.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function runTask(pending: AnswerPending, resumeOnly = true) {
    cancelled.current.delete(pending.request.client_request_id);
    const session = latest.current.session;
    if (!session) throw new Error('请先连接本地 API');
    let task = pending.api_job_id
      ? await api.pollAnswer(pending.api_job_id, session)
      : resumeOnly
        ? await api.findAnswerRequest(
            pending.request.client_request_id,
            session,
          )
        : await api.startAnswer(pending.request, session);
    if (!alive.current) return;
    await latest.current.updateCareer((c) => {
      if (
        !c.answer_pending?.some(
          (p) =>
            p.request.client_request_id === pending.request.client_request_id,
        )
      )
        throw new Error('生成已取消，未保存迟到结果');
      return {
        ...c,
        answer_pending: c.answer_pending.map((p) =>
          p.request.client_request_id === pending.request.client_request_id
            ? { ...p, api_job_id: task.job_id }
            : p,
        ),
      };
    });
    setMessage('开放题正在生成，检查点已加密保存；关闭后可恢复查询');
    while (alive.current && task.status === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (
        !alive.current ||
        cancelled.current.has(pending.request.client_request_id)
      )
        return;
      try {
        task = await api.pollAnswer(task.job_id, session);
      } catch (e) {
        if (cancelled.current.has(pending.request.client_request_id)) return;
        throw e;
      }
    }
    if (!alive.current) return;
    if (cancelled.current.has(pending.request.client_request_id)) return;
    if (task.status !== 'succeeded' || !task.result)
      throw new Error(
        task.error_code === 'EVIDENCE_INVALID'
          ? '模型未返回有效的完整事实引用，请补充资料后重新授权生成'
          : '开放题未生成可用草稿：' + (task.error_code ?? 'UNKNOWN'),
      );
    const draft = await acceptAnswer(
      pending.request.input,
      pending.facts,
      task.result,
      pending.request.consent,
    );
    if (!alive.current) return;
    await latest.current.updateCareer((c) => {
      if (
        !c.answer_pending?.some(
          (p) =>
            p.request.client_request_id === pending.request.client_request_id,
        )
      )
        throw new Error('生成已取消，未保存迟到结果');
      return {
        ...putAnswer(c, draft),
        answer_pending: c.answer_pending.filter(
          (p) =>
            p.request.client_request_id !== pending.request.client_request_id,
        ),
      };
    });
    if (!alive.current) return;
    setAnswerId(draft.answer_id);
    setMessage(
      '已生成有据草稿，请结合真实情况修改、保存并核对引用，再审核使用',
    );
    try {
      await api.deleteAnswerJob(task.job_id, session);
    } catch {
      /* The server clears results after TTL. */
    }
  }
  async function cancel(p: AnswerPending) {
    cancelled.current.add(p.request.client_request_id);
    setCancelling(true);
    let cleaned = false;
    try {
      const session = latest.current.session;
      if (session)
        try {
          const id =
            p.api_job_id ??
            (await api.findAnswerRequest(p.request.client_request_id, session))
              .job_id;
          await api.deleteAnswerJob(id, session);
          cleaned = true;
        } catch {
          /* Local cancellation still prevents late result acceptance. */
        }
      await latest.current.updateCareer((c) => ({
        ...c,
        answer_pending: (c.answer_pending ?? []).filter(
          (x) => x.request.client_request_id !== p.request.client_request_id,
        ),
      }));
      if (alive.current)
        setMessage(
          cleaned
            ? '开放题生成已取消，服务端任务已清理'
            : '本地检查点已取消；未确认清理的服务端结果会在五分钟内到期',
        );
    } catch (e) {
      if (alive.current)
        setMessage(e instanceof Error ? e.message : '取消未完成');
    } finally {
      if (alive.current) setCancelling(false);
    }
  }
  async function generate() {
    if (
      !job ||
      !preview ||
      !consent ||
      !caps?.operations.includes('answer_generate') ||
      !latest.current.session
    )
      throw new Error('请连接 API，核对发送内容并授权本次生成');
    const fresh = await latest.current.fresh(),
      sourceJob = fresh.career?.jobs.find((j) => j.job_id === job.job_id);
    if (!sourceJob) throw new Error('来源岗位已删除');
    const source = makeAnswerInput(sourceJob, fresh, question, chosen);
    if (canonicalJson(source.input) !== canonicalJson(preview.input))
      throw new Error('岗位或资料已变化，请重新核对发送内容');
    const request: AnswerRequest = {
      schema_version: 1,
      client_request_id: crypto.randomUUID(),
      input: source.input,
      consent: {
        granted: true,
        purpose: 'answer_generate',
        provider: caps.provider,
        model: caps.model,
        policy_url: caps.policy_url,
        payload_hash: await hashJson(source.input),
        granted_at: Date.now(),
      },
    };
    const pending: AnswerPending = {
      request,
      facts: source.facts,
      api_job_id: null,
      started_at: Date.now(),
    };
    await latest.current.updateCareer((c, p) => {
      if (
        p.profile_revision !== source.input.profile_revision ||
        c.jobs.find((j) => j.job_id === sourceJob.job_id)?.revision !==
          sourceJob.revision
      )
        throw new Error('资料已变化，请重新核对');
      if ((c.answers?.length ?? 0) + (c.answer_pending?.length ?? 0) >= 30)
        throw new Error('答案与待生成任务已达 30 份，请先删除答案或取消任务');
      if ((c.answer_pending?.length ?? 0) >= 3)
        throw new Error('请先处理现有开放题检查点');
      return { ...c, answer_pending: [...(c.answer_pending ?? []), pending] };
    });
    setConsent(false);
    await runTask(pending, false);
  }
  async function edit(change: Parameters<typeof reviseAnswer>[1]) {
    if (!answer) return;
    await latest.current.updateCareer((c, p) => {
      const saved = c.answers?.find((a) => a.answer_id === answer.answer_id),
        source = c.jobs.find((j) => j.job_id === answer.input.job.job_id);
      if (!saved || saved.revision !== answer.revision || !source)
        throw new Error('答案或岗位已变化，请重新读取');
      return putAnswer(
        c,
        reviseAnswer(saved, change, source, p),
        saved.revision,
      );
    });
    if (alive.current)
      setMessage(
        change.approve
          ? '此答案已由你修改并审核，可复制或导出'
          : '修改已加密保存，审核状态已清除',
      );
  }
  async function useAnswer(copy: boolean) {
    if (!answer || dirty) throw new Error('请先保存修改并审核答案');
    const fresh = await latest.current.fresh(),
      saved = fresh.career?.answers?.find(
        (a) => a.answer_id === answer.answer_id,
      ),
      source = fresh.career?.jobs.find(
        (j) => j.job_id === answer.input.job.job_id,
      );
    if (!saved || saved.revision !== answer.revision || !source)
      throw new Error('答案已变化，请重新核对');
    const result = exportAnswer(saved, source, fresh);
    if (!alive.current) return;
    if (copy) {
      await navigator.clipboard.writeText(result);
      if (alive.current)
        setMessage('已复制审核后的答案，请在目标页面人工核对后使用');
    } else {
      const url = URL.createObjectURL(
        new Blob([result], { type: 'text/plain;charset=utf-8' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download =
        '开放题-' +
        saved.answer_id.slice(0, 8) +
        '-v' +
        saved.revision +
        '.txt';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage('已导出审核后的答案文本');
    }
  }
  return (
    <details className="career-panel" data-testid="answer-panel">
      <summary>M5.3 · 开放题回答</summary>
      <p>
        选取已确认经历，生成带引用的回答草稿。模型不能增加事实；请修改为符合本人真实情况的回答，保存并审核后再使用。
      </p>
      <p role="note" data-testid="answer-status">
        {message}
      </p>
      <label>
        开放题目标岗位
        <select
          aria-label="开放题目标岗位"
          value={job?.job_id ?? ''}
          disabled={busy || dirty}
          onChange={(e) => {
            setJobId(e.target.value);
            setAnswerId('');
          }}
        >
          <option value="">暂无岗位</option>
          {career.jobs.map((j) => (
            <option key={j.job_id} value={j.job_id}>
              {j.attributes.find((a) => a.key === 'title')?.value ||
                j.source.title_hint ||
                '未命名岗位'}{' '}
              · v{j.revision}
            </option>
          ))}
        </select>
      </label>
      <div className="actions">
        {[
          '请介绍你的优势',
          '为什么选择本公司',
          '描述一次项目经历',
          '你遇到的最大挑战是什么',
        ].map((q) => (
          <button key={q} disabled={busy} onClick={() => setQuestion(q)}>
            {q}
          </button>
        ))}
      </div>
      <label>
        开放题问题
        <textarea
          aria-label="开放题问题"
          maxLength={1500}
          rows={3}
          value={question}
          disabled={busy}
          onChange={(e) => setQuestion(e.target.value)}
        />
      </label>
      <h3>本次发送的经历事实（{chosen.length}/16）</h3>
      <p className="small">
        只发送问题、岗位要求与勾选事实值；不发送原始简历文件、原文证据或其他未选资料。联系方式、性别、证书编号、薪资不作为可选字段。
      </p>
      <div className="actions">
        <button
          disabled={busy || !facts.length}
          onClick={() => setSelected(facts.slice(0, 16).map((f) => f.fact_id))}
        >
          选入前 16 条可用事实
        </button>
        <button
          disabled={busy || !chosen.length}
          onClick={() => setSelected([])}
        >
          清空本次选择
        </button>
      </div>
      {!facts.length && (
        <p className="small">暂无可选事实，请先在资料库补充并确认相关经历。</p>
      )}
      <div className="answer-facts">
        {facts.map((f) => (
          <label className="check" key={f.fact_id}>
            <input
              type="checkbox"
              aria-label={`发送${resumeFactLabels[f.path]}：${displayValue(f.value)}`}
              checked={chosen.includes(f.fact_id)}
              disabled={
                busy || (chosen.length >= 16 && !chosen.includes(f.fact_id))
              }
              onChange={(e) =>
                setSelected(
                  e.target.checked
                    ? [...chosen, f.fact_id]
                    : chosen.filter((id) => id !== f.fact_id),
                )
              }
            />
            <span className="resume-value">
              {resumeFactLabels[f.path]}：{displayValue(f.value)}
            </span>
          </label>
        ))}
      </div>
      <details>
        <summary>核对本次发送内容</summary>
        {preview ? (
          <div data-testid="answer-payload">
            <p>{preview.input.question}</p>
            <p>
              岗位：{preview.input.job.title || '未提供'}；公司：
              {preview.input.job.company || '未提供'}。
            </p>
            {preview.input.job.requirements.map((r) => (
              <blockquote key={r.requirement_id}>{r.quote}</blockquote>
            ))}
            {preview.facts.map((f) => (
              <p className="resume-value" key={f.fact_id}>
                {resumeFactLabels[f.path]}：{answerFactValue(f)}
              </p>
            ))}
          </div>
        ) : (
          <p>请选择已核对岗位、填写问题并选取 1～16 条事实。</p>
        )}
      </details>
      <p>
        {caps?.provider || '未连接'} · {caps?.model || '模型未配置'}{' '}
        {caps?.policy_url && (
          <a href={caps.policy_url} target="_blank" rel="noreferrer">
            供应商数据政策
          </a>
        )}
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={consent}
          disabled={busy}
          onChange={(e) => setConsent(e.target.checked)}
        />
        同意本次将所示问题、岗位要求与选中事实发送给上述模型供应商
      </label>
      <button
        disabled={
          busy ||
          !preview ||
          !consent ||
          !props.session ||
          !caps?.operations.includes('answer_generate') ||
          (career.answers?.length ?? 0) +
            (career.answer_pending?.length ?? 0) >=
            30 ||
          dirty
        }
        onClick={() => void work(generate)}
      >
        授权生成开放题草稿
      </button>
      {(career.answers?.length ?? 0) + (career.answer_pending?.length ?? 0) >=
        30 && (
        <p className="small">
          答案与待生成任务已达 30 份，请先删除答案或取消任务。
        </p>
      )}
      {(career.answer_pending ?? []).map((p) => (
        <article className="fact" key={p.request.client_request_id}>
          <strong>开放题生成检查点</strong>
          <p>{p.request.input.question}</p>
          <button
            disabled={busy || !props.session}
            onClick={() => void work(() => runTask(p))}
          >
            恢复开放题生成
          </button>
          <button disabled={cancelling} onClick={() => void cancel(p)}>
            取消开放题生成
          </button>
        </article>
      ))}
      {answer && (
        <>
          <label>
            已保存开放题答案
            <select
              aria-label="已保存开放题答案"
              disabled={busy || dirty}
              value={answer.answer_id}
              onChange={(e) => setAnswerId(e.target.value)}
            >
              {answers.map((a) => (
                <option key={a.answer_id} value={a.answer_id}>
                  {a.input.question.slice(0, 50)} · v{a.revision}
                </option>
              ))}
            </select>
          </label>
          <p>
            岗位 v{answer.input.job.revision} · 档案 v
            {answer.input.profile_revision} ·{' '}
            {answer.status === 'approved'
              ? '已审核'
              : answer.user_edited
                ? '已修改，待审核'
                : '生成草稿，待本人修改'}
          </p>
          {stale && (
            <p role="alert">
              答案已过期：岗位、资料、日期或规则发生变化，请核对本次发送内容并重新授权生成。
            </p>
          )}
          <h3>{answer.input.question}</h3>
          <details>
            <summary>查看生成草稿与引用</summary>
            <p className="small">
              本次供应商：{answer.consent.provider} · {answer.consent.model}
              ；授权时间：{new Date(answer.consent.granted_at).toLocaleString()}
              。
            </p>
            <pre className="resume-value">{answer.result.generated_text}</pre>
            {answer.result.selection.citations.map((c) => {
              const f = answer.facts.find((f) => f.fact_id === c.fact_id)!;
              return (
                <article className="fact" key={c.fact_id}>
                  <p>
                    {resumeFactLabels[f.path]} ·{' '}
                    {f.source_type === 'resume' ? '简历原文' : '用户确认'} ·
                    事实 v{f.fact_revision}
                  </p>
                  <blockquote>{c.quote}</blockquote>
                  {c.requirement_ids.map((id) => (
                    <blockquote key={id}>
                      岗位对照：
                      {
                        answer.input.job.requirements.find(
                          (r) => r.requirement_id === id,
                        )?.quote
                      }
                    </blockquote>
                  ))}
                  {f.evidences.map((e) => (
                    <blockquote key={e.evidence_id}>
                      对照材料：{e.quote}
                    </blockquote>
                  ))}
                </article>
              );
            })}
          </details>
          <p className="small">
            修改后的正文由你负责核实；引用仅证明生成草稿的材料来源，程序不会自动验证你新增的陈述。动机、挑战和结果若缺少明确材料，需要本人补充真实内容。
          </p>
          <label>
            本人修改后的答案
            <textarea
              aria-label="本人修改后的答案"
              maxLength={6000}
              rows={10}
              value={text}
              disabled={busy || stale}
              onChange={(e) =>
                setEditing({ key: editorKey, text: e.target.value })
              }
            />
          </label>
          {dirty && <p role="note">存在未保存修改，保存后需重新审核。</p>}
          <div className="actions">
            <button
              disabled={busy || stale || !dirty || !text.trim()}
              onClick={() => void work(() => edit({ text }))}
            >
              保存答案修改
            </button>
            <button disabled={busy || !dirty} onClick={() => setEditing(null)}>
              放弃答案未保存修改
            </button>
            <button
              disabled={
                busy ||
                stale ||
                dirty ||
                !answer.user_edited ||
                answer.status === 'approved'
              }
              onClick={() => void work(() => edit({ approve: true }))}
            >
              我已修改并核实答案，审核此版本
            </button>
            <button
              disabled={busy || stale || dirty || answer.status !== 'approved'}
              onClick={() => void work(() => useAnswer(true))}
            >
              复制审核后的答案
            </button>
            <button
              disabled={busy || stale || dirty || answer.status !== 'approved'}
              onClick={() => void work(() => useAnswer(false))}
            >
              导出审核后的答案
            </button>
          </div>
          <button
            disabled={busy || dirty}
            onClick={() => {
              setQuestion(answer.input.question);
              setSelected(
                answer.input.facts
                  .map((f) => f.fact_id)
                  .filter((id) => facts.some((f) => f.fact_id === id)),
              );
              setConsent(false);
            }}
          >
            将此问题与事实带入重新生成
          </button>
          <details>
            <summary>答案修订历史（{answer.history.length}）</summary>
            {[...answer.history].reverse().map((v) => (
              <article key={v.revision}>
                <p>
                  v{v.revision} ·{' '}
                  {v.status === 'approved' ? '当时已审核' : '待审核'}
                </p>
                <pre className="resume-value">{v.text}</pre>
                <button
                  disabled={busy || stale || dirty}
                  onClick={() =>
                    void work(() => edit({ restore_revision: v.revision }))
                  }
                >
                  恢复答案 v{v.revision}
                </button>
              </article>
            ))}
          </details>
          <button
            disabled={busy || dirty}
            onClick={() =>
              void work(async () => {
                await latest.current.updateCareer((c) => ({
                  ...c,
                  answers: (c.answers ?? []).filter(
                    (a) => a.answer_id !== answer.answer_id,
                  ),
                }));
                if (alive.current) {
                  setAnswerId('');
                  setMessage('此开放题答案及修订历史已删除');
                }
              })
            }
          >
            删除此开放题答案及修订
          </button>
        </>
      )}
    </details>
  );
}
