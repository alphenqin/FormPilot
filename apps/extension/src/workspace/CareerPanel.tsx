import { useEffect, useRef, useState } from 'react';
import { Value } from '@sinclair/typebox/value';
import {
  JobCaptureResultSchema,
  hashJson,
  type CareerState,
  type JobSource,
  type JobDocument,
  type JobRequirement,
  type JobKind,
  type JobPriority,
  type JobParseRequest,
  type JobMatch,
} from '@formpilot/contracts';
import {
  acceptParsedJob,
  manualJob,
  reviseJob,
  putCareerJob,
  matchJob,
  putJobMatch,
  isJobMatchCurrent,
  emptyCareer,
  displayValue,
  type ProfileState,
} from '@formpilot/domain';
import * as api from './api';
import { factLabels } from './labels';
const kindNames: Record<JobKind, string> = {
  education: '学历',
  experience: '经验年限',
  skill: '技能',
  location: '地点',
  major: '专业',
  responsibility: '职责/能力',
  other: '其他限制',
};
const priorityNames: Record<JobPriority, string> = {
  hard: '硬性条件',
  core: '核心能力',
  preferred: '优先条件',
};
const statusNames = {
  matched: '已匹配',
  insufficient: '证据不足',
  needs_confirmation: '待确认',
  unmatched: '不匹配',
};
const errorNames: Record<string, string> = {
  MODEL_TIMEOUT: 'JD 解析超时，请恢复查询或重新授权后重试',
  MODEL_INVALID_OUTPUT: '模型输出不符合要求，没有保存为岗位事实',
  EVIDENCE_INVALID: '模型引用不真实或原文出现多处，请使用更完整的原文片段',
  REVISION_CONFLICT: '岗位版本已变化，请重新查看后操作',
  CONSENT_REQUIRED: '本次授权过期或文本已变化，请重新确认后解析',
};
const messageOf = (e: unknown) =>
  e instanceof Error
    ? (errorNames[e.message] ?? e.message)
    : '操作失败，请重试';
function RequirementEditor({
  r,
  busy,
  change,
  remove,
  locate,
}: {
  r: JobRequirement;
  busy: boolean;
  change: (change: {
    kind: JobKind;
    priority: JobPriority;
    term: string | null;
    confirmed: boolean;
  }) => void;
  remove: () => void;
  locate: () => void;
}) {
  const [kind, setKind] = useState(r.kind),
    [priority, setPriority] = useState(r.priority),
    [term, setTerm] = useState(r.term ?? '');
  useEffect(() => {
    setKind(r.kind);
    setPriority(r.priority);
    setTerm(r.term ?? '');
  }, [r.kind, r.priority, r.term]);
  const dirty =
    kind !== r.kind ||
    priority !== r.priority ||
    (term.trim() || null) !== r.term;
  return (
    <article className="fact career-requirement" data-testid="job-requirement">
      <strong>
        {priorityNames[r.priority]} · {kindNames[r.kind]}
      </strong>
      <span className="pill">{r.confirmed ? '原文已确认' : '待核对'}</span>
      <blockquote>{r.quote}</blockquote>
      <div className="career-edit">
        <label>
          要求分类
          <select
            aria-label="要求分类"
            value={kind}
            onChange={(e) => setKind(e.target.value as JobKind)}
          >
            {Object.entries(kindNames).map(([v, n]) => (
              <option key={v} value={v}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          要求级别
          <select
            aria-label="要求级别"
            value={priority}
            onChange={(e) => setPriority(e.target.value as JobPriority)}
          >
            {Object.entries(priorityNames).map(([v, n]) => (
              <option key={v} value={v}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          原文中的技能/专业/城市词
          <input
            aria-label="要求关键词"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
        </label>
      </div>
      <p className="small">
        {r.criterion.type === 'unknown'
          ? '含有额外、复合或未支持的条件，匹配时保留人工核实。'
          : '可与明确的已确认事实逐项核对。'}
        确认表示提取无误，不表示你已满足要求。
      </p>
      <div className="actions">
        <button
          disabled={busy || !dirty}
          onClick={() =>
            change({
              kind,
              priority,
              term: term.trim() || null,
              confirmed: false,
            })
          }
        >
          保存要求修改
        </button>
        <button
          disabled={busy || dirty || r.confirmed}
          onClick={() =>
            change({ kind, priority, term: r.term, confirmed: true })
          }
        >
          确认这条要求
        </button>
        <button disabled={busy} onClick={locate}>
          定位 JD 原文
        </button>
        <button disabled={busy} onClick={remove}>
          删除这条提取
        </button>
      </div>
    </article>
  );
}
function downloadReport(
  job: JobDocument,
  analysis: JobMatch,
  profile: ProfileState,
) {
  const version =
      job.revision === analysis.job_revision
        ? job
        : job.history.find((v) => v.revision === analysis.job_revision),
    current = isJobMatchCurrent(analysis, job, profile);
  const lines = [
    '# 岗位与经历证据对照',
    current
      ? '当前计算结果'
      : '历史结果：资料、岗位或计算日期已变化，请重新匹配。',
    `截至：${analysis.as_of}；岗位 v${analysis.job_revision}；档案 v${analysis.profile_revision}`,
    `引擎：${analysis.engine_version}`,
    '本报告不是录用决定，不证明全部 JD 要求均已提取。',
    '',
  ];
  for (const row of analysis.rows) {
    const r = version?.requirements.find(
      (r) => r.requirement_id === row.requirement_id,
    );
    lines.push(
      `## ${statusNames[row.status]}`,
      r?.quote ?? '旧版本要求已超过保留范围',
      row.explanation,
    );
    for (const ref of row.fact_refs) {
      const fact = profile.facts.find(
        (f) =>
          f.fact_id === ref.fact_id && f.fact_revision === ref.fact_revision,
      );
      lines.push(
        fact
          ? `- ${factLabels[fact.path]}：${displayValue(fact.value)}（${fact.source_type === 'resume' ? '简历原文' : '用户确认'}，事实 v${ref.fact_revision}）`
          : '- 历史事实引用不可用',
      );
    }
    for (const id of row.evidence_ids) {
      const evidence = profile.evidences.find((e) => e.evidence_id === id);
      if (evidence) lines.push('> 原始材料引用：' + evidence.quote);
    }
    lines.push('');
  }
  const url = URL.createObjectURL(
      new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }),
    ),
    a = document.createElement('a');
  a.href = url;
  a.download = '岗位证据对照-' + analysis.as_of + '.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function CareerPanel(props: {
  profile: ProfileState;
  session: api.ApiSession | null;
  fresh: () => Promise<ProfileState>;
  updateCareer: (
    change: (c: CareerState) => CareerState,
  ) => Promise<ProfileState>;
}) {
  const latest = useRef(props);
  latest.current = props;
  const career = props.profile.career ?? emptyCareer();
  const [text, setText] = useState(''),
    [hint, setHint] = useState(''),
    [captured, setCaptured] = useState<JobSource | null>(null),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [caps, setCaps] = useState<Awaited<
      ReturnType<typeof api.capabilities>
    > | null>(null),
    [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]),
    [tab, setTab] = useState(''),
    [selected, setSelected] = useState(career.jobs.at(-1)?.job_id ?? ''),
    [analysisId, setAnalysisId] = useState(''),
    [focus, setFocus] = useState<string | null>(null);
  const [quote, setQuote] = useState(''),
    [addKind, setAddKind] = useState<JobKind>('skill'),
    [addPriority, setAddPriority] = useState<JobPriority>('hard'),
    [addTerm, setAddTerm] = useState('');
  const active = useRef(false),
    alive = useRef(true),
    original = useRef<HTMLDivElement>(null);
  const job =
    career.jobs.find((j) => j.job_id === selected) ??
    career.jobs.at(-1) ??
    null;
  const analyses = career.analyses.filter((a) => a.job_id === job?.job_id),
    analysis =
      analyses.find((a) => a.analysis_id === analysisId) ??
      analyses.at(-1) ??
      null;
  const stale = !!(
    job &&
    analysis &&
    !isJobMatchCurrent(analysis, job, props.profile)
  );
  useEffect(() => {
    alive.current = true;
    void api
      .capabilities()
      .then((c) => {
        if (alive.current) setCaps(c);
      })
      .catch(() => {});
    return () => {
      alive.current = false;
    };
  }, [props.session]);
  useEffect(() => {
    setConsent(false);
  }, [text, captured, hint, props.session]);
  async function work(fn: () => Promise<void>) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (e) {
      if (alive.current) setMessage(messageOf(e));
    } finally {
      active.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const makeSource = (): JobSource =>
    captured && captured.text === text
      ? { ...captured, title_hint: hint || captured.title_hint }
      : {
          source_id: crypto.randomUUID(),
          text,
          title_hint: hint,
          page_url: null,
          captured_at: Date.now(),
          method: 'paste',
        };
  async function addParsed(
    source: JobSource,
    result: Parameters<typeof acceptParsedJob>[1],
    requestId: string,
  ) {
    const doc = await acceptParsedJob(source, result);
    await latest.current.updateCareer((c) => {
      if (!c.pending?.some((p) => p.request.client_request_id === requestId))
        throw new Error('解析已取消，未保存迟到结果');
      const next = putCareerJob(c, doc);
      return {
        ...next,
        pending: (next.pending ?? []).filter(
          (p) => p.request.client_request_id !== requestId,
        ),
      };
    });
    if (!alive.current) return;
    setSelected(doc.job_id);
    setAnalysisId('');
    setMessage('JD 解析完成，请逐条核对原文、条件和级别后再匹配');
  }
  async function runTask(request: JobParseRequest, id: string | null) {
    const session = latest.current.session;
    if (!session) throw new Error('请先连接本地 API');
    let task = id
      ? await api.pollJobParse(id, session)
      : await api.startJobParse(request, session);
    await latest.current.updateCareer((c) => ({
      ...c,
      pending: (c.pending ?? []).map((p) =>
        p.request.client_request_id === request.client_request_id
          ? { ...p, api_job_id: task.job_id }
          : p,
      ),
    }));
    setMessage('JD 正在解析，原文已加密保存，可关闭后重新解锁恢复查询');
    while (alive.current && task.status === 'running') {
      await new Promise((r) => setTimeout(r, 600));
      if (!alive.current) return;
      task = await api.pollJobParse(task.job_id, session);
    }
    if (!alive.current) return;
    if (task.status !== 'succeeded' || !task.result)
      throw new Error(
        errorNames[task.error_code ?? ''] ??
          'JD 解析未成功，请查看原文并重新授权后重试',
      );
    await addParsed(request.source, task.result, request.client_request_id);
    try {
      await api.deleteJobParse(task.job_id, session);
    } catch {
      setMessage('JD 已在本地保存；服务端缓存将在五分钟内到期');
    }
  }
  async function parse() {
    if (!consent || !caps?.career_available || !latest.current.session)
      throw new Error('请先连接 API 并同意本次发送 JD 原文');
    const source = makeSource();
    const request: JobParseRequest = {
      schema_version: 1,
      client_request_id: crypto.randomUUID(),
      source,
      consent: {
        granted: true,
        purpose: 'jd_parse',
        provider: caps.provider,
        model: caps.model,
        policy_url: caps.policy_url,
        payload_hash: await hashJson({ source }),
        granted_at: Date.now(),
      },
    };
    await latest.current.updateCareer((c) => {
      if ((c.pending?.length ?? 0) >= 3)
        throw new Error('请先处理现有 JD 解析检查点');
      return {
        ...c,
        pending: [
          ...(c.pending ?? []),
          { request, api_job_id: null, started_at: Date.now() },
        ],
      };
    });
    setConsent(false);
    await runTask(request, null);
  }
  async function changeJob(change: Parameters<typeof reviseJob>[1]) {
    if (!job) return;
    const current = job;
    await latest.current.updateCareer((c) => {
      const stored = c.jobs.find((j) => j.job_id === current.job_id);
      if (!stored || stored.revision !== current.revision)
        throw new Error('REVISION_CONFLICT');
      return putCareerJob(c, reviseJob(stored, change), stored.revision);
    });
    setMessage('岗位审阅已保存；旧匹配保留为历史，需重新计算');
  }
  function locate(r: JobRequirement) {
    setFocus(r.requirement_id);
    original.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  async function match() {
    if (!job) return;
    const fresh = await latest.current.fresh(),
      current = fresh.career?.jobs.find((j) => j.job_id === job.job_id);
    if (!current || current.revision !== job.revision)
      throw new Error('REVISION_CONFLICT');
    const result = await matchJob(current, fresh);
    const saved = await latest.current.updateCareer((c) =>
      putJobMatch(c, result),
    );
    if (!alive.current) return;
    setAnalysisId(result.analysis_id);
    setMessage(
      saved.profile_revision === result.profile_revision
        ? '已完成本地逐项证据对照；缺项未被当作不具备'
        : '计算期间资料已变化，结果已保留为历史，请重新匹配',
    );
  }
  return (
    <details className="career-panel" data-testid="career-panel">
      <summary>M5.1 · JD 与岗位匹配</summary>
      <section>
        <h2>岗位要求与经历证据</h2>
        <p>
          模型只解析本次 JD
          原文；个人事实留在本地匹配。先核对提取的要求，再查看逐项证据，不给无依据的录用结论或总分。
        </p>
        <p data-testid="career-status" role="note">
          {message}
        </p>
        <div className="career-columns">
          <div>
            <h3>导入岗位正文</h3>
            <button
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  const values = (await chrome.tabs.query({})).filter(
                    (t) =>
                      t.id !== undefined &&
                      (!t.url || /^https?:\/\//.test(t.url)),
                  );
                  setTabs(values);
                  if (values[0]?.id !== undefined) setTab(String(values[0].id));
                })
              }
            >
              刷新岗位标签页
            </button>
            <label>
              岗位标签页
              <select
                aria-label="岗位标签页"
                value={tab}
                onChange={(e) => setTab(e.target.value)}
              >
                <option value="">请选择</option>
                {tabs.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title ?? '标签页'} · {t.id}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={busy || !tab}
              onClick={() =>
                void work(async () => {
                  const response = await chrome.runtime.sendMessage({
                    protocol_version: '1',
                    request_id: crypto.randomUUID(),
                    task_id: null,
                    method: 'career.capture',
                    tab_id: Number(tab),
                  });
                  if (response.error) throw new Error(response.error.message);
                  if (!Value.Check(JobCaptureResultSchema, response.data))
                    throw new Error('岗位正文响应无效');
                  const data = response.data;
                  setCaptured(data.source);
                  setText(data.source.text);
                  setHint(data.source.title_hint);
                  setMessage(
                    data.warning_codes.length
                      ? '已读取页面；请核对提取范围并删除非 JD 信息，截断时需补充原文'
                      : '已读取岗位正文，请核对后再授权解析',
                  );
                })
              }
            >
              读取岗位正文
            </button>
            <p className="small">
              先在岗位详情页点击 FormPilot
              图标授予当前页权限。不能读取的页面可直接粘贴；不会自动访问任意链接或上传整页
              HTML。
            </p>
            <label>
              岗位备注（仅作本地标记）
              <input
                aria-label="岗位备注"
                value={hint}
                onChange={(e) => setHint(e.target.value)}
              />
            </label>
            <label>
              JD 原文
              <textarea
                aria-label="JD 原文"
                rows={10}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  if (captured) setCaptured(null);
                }}
              />
            </label>
            <p className="small">
              {text.length} / 20000 字符。
              {captured?.page_url ? '来源：' + captured.page_url : '手动文本'}
              {captured?.truncated ? ' · 原文已截断，本次只分析截取部分' : ''}
            </p>
            <p>
              {caps?.provider ?? '未连接'} · {caps?.model ?? '模型未配置'}
            </p>
            {caps?.policy_url && (
              <a href={caps.policy_url} target="_blank" rel="noreferrer">
                供应商数据政策
              </a>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={consent}
                disabled={busy}
                onChange={(e) => setConsent(e.target.checked)}
              />
              同意本次将所示 JD 原文发送给上述模型供应商
            </label>
            <div className="actions">
              <button
                disabled={
                  busy ||
                  !text.trim() ||
                  text.length > 20000 ||
                  !props.session ||
                  !consent ||
                  !caps?.career_available
                }
                onClick={() => void work(parse)}
              >
                授权解析 JD
              </button>
              <button
                disabled={busy || !text.trim() || text.length > 20000}
                onClick={() =>
                  void work(async () => {
                    const doc = await manualJob(makeSource());
                    await latest.current.updateCareer((c) =>
                      putCareerJob(c, doc),
                    );
                    setSelected(doc.job_id);
                    setMessage('已仅在本地保存，请从原文添加要求并确认');
                  })
                }
              >
                仅保存 JD 并手动标注
              </button>
            </div>
            {(career.pending ?? []).map((p) => (
              <article className="fact" key={p.request.client_request_id}>
                <strong>JD 解析检查点</strong>
                <p>
                  {p.request.source.title_hint ||
                    p.request.source.text.slice(0, 40)}
                </p>
                <button
                  disabled={busy || !props.session}
                  onClick={() =>
                    void work(() => runTask(p.request, p.api_job_id))
                  }
                >
                  恢复 JD 解析
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void work(async () => {
                      if (p.api_job_id && latest.current.session)
                        try {
                          await api.deleteJobParse(
                            p.api_job_id,
                            latest.current.session,
                          );
                        } catch {
                          /* TTL clears the remote result. */
                        }
                      await latest.current.updateCareer((c) => ({
                        ...c,
                        pending: (c.pending ?? []).filter(
                          (x) =>
                            x.request.client_request_id !==
                            p.request.client_request_id,
                        ),
                      }));
                      setMessage(
                        '本地检查点已取消；未能确认清理的服务端结果五分钟内到期',
                      );
                    })
                  }
                >
                  取消此 JD 解析
                </button>
              </article>
            ))}
          </div>
          <div>
            <label>
              已保存岗位
              <select
                aria-label="已保存岗位"
                disabled={busy}
                value={job?.job_id ?? ''}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setAnalysisId('');
                  setFocus(null);
                }}
              >
                <option value="">暂无岗位</option>
                {career.jobs.map((j) => (
                  <option key={j.job_id} value={j.job_id}>
                    {j.attributes.find((a) => a.key === 'title')?.value ??
                      j.source.title_hint ??
                      '未命名岗位'}{' '}
                    · v{j.revision}
                  </option>
                ))}
              </select>
            </label>
            {job && (
              <>
                <h3>
                  {job.attributes.find((a) => a.key === 'title')?.value ||
                    job.source.title_hint ||
                    '岗位原文'}{' '}
                  · v{job.revision}
                </h3>
                <p>
                  {job.reviewed
                    ? '已核对提取项，可执行本地匹配'
                    : '岗位提取项待核对'}{' '}
                  · {job.requirements.length} 条要求
                  {job.source.truncated ? ' · 来源文本已截断' : ''}
                </p>
                {job.attributes.map((a) => (
                  <p key={a.attribute_id}>
                    {a.key === 'title'
                      ? '岗位'
                      : a.key === 'company'
                        ? '公司'
                        : '地点'}
                    ：{a.value} · 原文“{a.quote}”
                    <button
                      disabled={busy}
                      onClick={() =>
                        void work(() =>
                          changeJob({ remove_attribute: a.attribute_id }),
                        )
                      }
                    >
                      删除此岗位属性
                    </button>
                  </p>
                ))}
                <div
                  ref={original}
                  className="career-source"
                  data-testid="job-original"
                >
                  <strong>JD 原文</strong>
                  {focus &&
                  job.requirements.find((r) => r.requirement_id === focus) ? (
                    (() => {
                      const r = job.requirements.find(
                        (r) => r.requirement_id === focus,
                      )!;
                      return (
                        <pre>
                          {job.source.text.slice(0, r.start)}
                          <mark>{r.quote}</mark>
                          {job.source.text.slice(r.end)}
                        </pre>
                      );
                    })()
                  ) : (
                    <pre>{job.source.text}</pre>
                  )}
                </div>
                <p className="small">
                  提取项可能不完整，请对照原文补充遗漏要求。确认不等于符合岗位。
                </p>
                <button
                  disabled={busy || !job.requirements.length || job.reviewed}
                  onClick={() =>
                    void work(() => changeJob({ confirm_all: true }))
                  }
                >
                  确认已核对这些岗位要求
                </button>
                <div className="career-requirements">
                  {job.requirements.map((r) => (
                    <RequirementEditor
                      key={r.requirement_id}
                      r={r}
                      busy={busy}
                      locate={() => locate(r)}
                      remove={() =>
                        void work(() => changeJob({ remove: r.requirement_id }))
                      }
                      change={(c) =>
                        void work(() =>
                          changeJob({
                            requirement: {
                              requirement_id: r.requirement_id,
                              ...c,
                            },
                          }),
                        )
                      }
                    />
                  ))}
                </div>
                <details>
                  <summary>从原文补充遗漏要求</summary>
                  <label>
                    完整原文片段
                    <textarea
                      aria-label="补充要求原文"
                      value={quote}
                      onChange={(e) => setQuote(e.target.value)}
                    />
                  </label>
                  <label>
                    补充要求分类
                    <select
                      value={addKind}
                      onChange={(e) => setAddKind(e.target.value as JobKind)}
                    >
                      {Object.entries(kindNames).map(([v, n]) => (
                        <option value={v} key={v}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    补充要求级别
                    <select
                      value={addPriority}
                      onChange={(e) =>
                        setAddPriority(e.target.value as JobPriority)
                      }
                    >
                      {Object.entries(priorityNames).map(([v, n]) => (
                        <option value={v} key={v}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    补充要求关键词
                    <input
                      value={addTerm}
                      onChange={(e) => setAddTerm(e.target.value)}
                    />
                  </label>
                  <button
                    disabled={busy || !quote.trim()}
                    onClick={() =>
                      void work(async () => {
                        await changeJob({
                          add: {
                            quote,
                            kind: addKind,
                            priority: addPriority,
                            term: addTerm.trim() || null,
                          },
                        });
                        setQuote('');
                        setAddTerm('');
                      })
                    }
                  >
                    添加原文要求
                  </button>
                </details>
                <div className="actions">
                  <button
                    disabled={busy || !job.reviewed}
                    onClick={() => void work(match)}
                  >
                    开始本地岗位匹配
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void work(async () => {
                        await latest.current.updateCareer((c) => ({
                          ...c,
                          jobs: c.jobs.filter((j) => j.job_id !== job.job_id),
                          analyses: c.analyses.filter(
                            (a) => a.job_id !== job.job_id,
                          ),
                          ...(c.answers
                            ? {
                                answers: c.answers.filter(
                                  (a) => a.input.job.job_id !== job.job_id,
                                ),
                              }
                            : {}),
                          ...(c.answer_pending
                            ? {
                                answer_pending: c.answer_pending.filter(
                                  (p) =>
                                    p.request.input.job.job_id !== job.job_id,
                                ),
                              }
                            : {}),
                          ...(c.resumes
                            ? {
                                resumes: c.resumes.filter(
                                  (r) => r.job_id !== job.job_id,
                                ),
                              }
                            : {}),
                        }));
                        setSelected('');
                        setAnalysisId('');
                        setMessage('岗位、分析、岗位简历及开放题答案已删除');
                      })
                    }
                  >
                    删除此岗位、分析及岗位简历
                  </button>
                </div>
                <p className="small">
                  删除岗位也会清除其开放题答案、修订和本地生成检查点。
                </p>
                <details>
                  <summary>岗位修订历史（{job.history.length}）</summary>
                  {job.history.map((v) => (
                    <p key={v.revision}>
                      v{v.revision} · {v.requirements.length} 条要求 ·{' '}
                      {v.reviewed ? '已核对' : '待核对'}
                    </p>
                  ))}
                </details>
                {analysis && (
                  <div data-testid="job-match">
                    <h3>逐项经历证据对照</h3>
                    <label>
                      匹配历史
                      <select
                        value={analysis.analysis_id}
                        onChange={(e) => setAnalysisId(e.target.value)}
                      >
                        {analyses.map((a) => (
                          <option key={a.analysis_id} value={a.analysis_id}>
                            岗位 v{a.job_revision} · 档案 v{a.profile_revision}{' '}
                            · 截至 {a.as_of}
                          </option>
                        ))}
                      </select>
                    </label>
                    {stale && (
                      <p role="alert">
                        结果已过期：岗位、资料、日期或规则已变化，请重新匹配。
                      </p>
                    )}
                    <p>
                      {Object.entries(statusNames)
                        .map(
                          ([key, name]) =>
                            `${name} ${analysis.summary[key as keyof typeof analysis.summary]}`,
                        )
                        .join(' · ')}
                    </p>
                    <p className="small">
                      截至 {analysis.as_of}
                      ，仅对已核对的提取项逐条判断；不是完整资格或录用结论。
                    </p>
                    {analysis.rows.map((row) => {
                      const version =
                          job.revision === analysis.job_revision
                            ? job
                            : job.history.find(
                                (v) => v.revision === analysis.job_revision,
                              ),
                        r = version?.requirements.find(
                          (r) => r.requirement_id === row.requirement_id,
                        );
                      return (
                        <article
                          className={'fact match-' + row.status}
                          key={row.requirement_id}
                          data-testid="job-match-row"
                        >
                          <strong>
                            {statusNames[row.status]} ·{' '}
                            {r ? priorityNames[r.priority] : ''}
                          </strong>
                          <blockquote>
                            {r?.quote ?? '旧版本要求已超过保留范围'}
                          </blockquote>
                          <p>{row.explanation}</p>
                          {row.fact_refs.map((ref) => {
                            const fact = props.profile.facts.find(
                              (f) =>
                                f.fact_id === ref.fact_id &&
                                f.fact_revision === ref.fact_revision,
                            );
                            return (
                              <p className="small" key={ref.fact_id}>
                                {fact
                                  ? `${factLabels[fact.path]}：${displayValue(fact.value)} · ${fact.source_type === 'resume' ? '简历原文' : '用户确认'} · 事实 v${ref.fact_revision}`
                                  : '历史事实引用已不可用'}
                              </p>
                            );
                          })}
                          {row.evidence_ids.map((id) => (
                            <blockquote key={id}>
                              原始材料：
                              {props.profile.evidences.find(
                                (e) => e.evidence_id === id,
                              )?.quote ?? '历史证据不可用'}
                            </blockquote>
                          ))}
                        </article>
                      );
                    })}
                    <button
                      disabled={busy}
                      onClick={() =>
                        downloadReport(job, analysis, props.profile)
                      }
                    >
                      导出岗位证据对照
                    </button>
                    <p className="small">
                      需要补充时，在下方资料库中新增或修改事实并确认，再重新匹配。JD
                      结果不会自动成为个人事实或 M4 填充值。
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </section>
    </details>
  );
}
