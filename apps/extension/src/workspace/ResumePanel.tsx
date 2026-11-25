import { useEffect, useRef, useState } from 'react';
import {
  canonicalJson,
  type CareerState,
  type ResumeVariant,
} from '@formpilot/contracts';
import {
  createResumeVariant,
  reviseResumeVariant,
  putResumeVariant,
  isResumeCurrent,
  exportResume,
  resumeSelectedBlocks,
  resumeCategoryNames,
  resumeFactLabels,
  resumeValue,
  emptyCareer,
  confirmedFacts,
  type ProfileState,
  type ResumeEdit,
} from '@formpilot/domain';

interface Props {
  profile: ProfileState;
  fresh: () => Promise<ProfileState>;
  updateCareer: (
    change: (state: CareerState, profile: ProfileState) => CareerState,
  ) => Promise<ProfileState>;
}
export function ResumePanel(props: Props) {
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
  const [jobId, setJobId] = useState(career.jobs.at(-1)?.job_id ?? '');
  const [resumeId, setResumeId] = useState('');
  const [newName, setNewName] = useState('');
  type Editor = {
    key: string;
    name: string;
    selected: string[];
    order: string[];
  };
  const [editing, setEditing] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const job =
    career.jobs.find((j) => j.job_id === jobId) ?? career.jobs.at(-1) ?? null;
  const variants = (career.resumes ?? []).filter(
    (r) => r.job_id === job?.job_id,
  );
  const resume =
    variants.find((r) => r.resume_id === resumeId) ?? variants.at(-1) ?? null;
  const editorKey = resume ? resume.resume_id + ':' + resume.revision : '';
  const editor: Editor =
    editing?.key === editorKey
      ? editing
      : {
          key: editorKey,
          name: resume?.name ?? '',
          selected: resume?.selected_fact_ids ?? [],
          order: resume?.block_order ?? [],
        };
  const { name, selected, order } = editor;
  function updateEditor(change: Partial<Omit<Editor, 'key'>>) {
    setEditing((old) => ({
      ...(old?.key === editorKey ? old : editor),
      ...change,
    }));
  }
  const setName = (name: string) => updateEditor({ name });
  const setSelected = (selected: string[]) => updateEditor({ selected });
  const setOrder = (order: string[]) => updateEditor({ order });
  const dirty =
    !!resume &&
    (name !== resume.name ||
      canonicalJson(selected) !== canonicalJson(resume.selected_fact_ids) ||
      canonicalJson(order) !== canonicalJson(resume.block_order));
  const stale = !!resume && !isResumeCurrent(resume, job, props.profile);
  const selectedSet = new Set(selected);
  const preview = resume
    ? resumeSelectedBlocks({
        ...resume,
        name,
        selected_fact_ids: selected,
        block_order: order,
      })
    : [];
  async function work(fn: () => Promise<void>) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (e) {
      if (alive.current)
        setMessage(e instanceof Error ? e.message : '简历操作未完成');
    } finally {
      active.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function generate(parent: ResumeVariant | null = null) {
    if (!job) throw new Error('请先保存并核对一个岗位');
    const fresh = await latest.current.fresh(),
      currentJob = fresh.career?.jobs.find((j) => j.job_id === job.job_id);
    if (!currentJob || currentJob.revision !== job.revision)
      throw new Error('岗位已变化，请重新核对后生成');
    const label =
      newName.trim() ||
      (parent
        ? parent.name.slice(0, 150) + '（更新）'
        : (
            (currentJob.attributes.find((a) => a.key === 'title')?.value ||
              currentJob.source.title_hint ||
              '岗位') + ' · 定制简历'
          ).slice(0, 160));
    const draft = await createResumeVariant(currentJob, fresh, label, parent);
    if (!alive.current) return;
    await latest.current.updateCareer((c, p) => {
      if (p.profile_revision !== draft.profile_revision)
        throw new Error('生成期间资料已变化，请重新生成');
      return putResumeVariant(c, draft);
    });
    if (alive.current) {
      setResumeId(draft.resume_id);
      setNewName('');
      setMessage('岗位版简历已加密保存，请选择内容、调整顺序并审核');
    }
  }
  async function edit(change: ResumeEdit) {
    if (!resume) return;
    const expected = resume;
    await latest.current.updateCareer((c, p) => {
      const saved = c.resumes?.find((r) => r.resume_id === expected.resume_id),
        source = c.jobs.find((j) => j.job_id === expected.job_id);
      if (!saved || saved.revision !== expected.revision)
        throw new Error('简历已在其他操作中修订，请重新读取');
      if (!source) throw new Error('岗位已删除');
      return putResumeVariant(
        c,
        reviseResumeVariant(saved, change, source, p),
        saved.revision,
      );
    });
    if (alive.current)
      setMessage(
        change.approve
          ? '此版本已审核，可导出岗位简历'
          : '简历修订已保存，请重新核对后审核',
      );
  }
  async function download(format: 'html' | 'markdown') {
    if (!resume || dirty) throw new Error('请先保存并审核当前修改');
    const fresh = await latest.current.fresh(),
      saved = fresh.career?.resumes?.find(
        (r) => r.resume_id === resume.resume_id,
      ),
      source = fresh.career?.jobs.find((j) => j.job_id === resume.job_id);
    if (!saved || saved.revision !== resume.revision || !source)
      throw new Error('简历版本已变化，请重新核对');
    const text = exportResume(saved, source, fresh, format);
    if (!alive.current) return;
    const url = URL.createObjectURL(
      new Blob([text], {
        type:
          format === 'html'
            ? 'text/html;charset=utf-8'
            : 'text/markdown;charset=utf-8',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `岗位简历-${saved.resume_id.slice(0, 8)}-v${saved.revision}.${format === 'html' ? 'html' : 'md'}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage(
      format === 'html'
        ? '已导出可打印 HTML，用浏览器打开后可打印或另存为 PDF'
        : '已导出岗位版 Markdown 简历',
    );
  }
  function move(index: number, offset: number) {
    const result = [...order],
      at = index + offset;
    if (at < 0 || at >= result.length) return;
    [result[index], result[at]] = [result[at]!, result[index]!];
    setOrder(result);
  }
  return (
    <details className="career-panel resume-panel" data-testid="resume-panel">
      <summary>M5.2 · 岗位版简历</summary>
      <p>
        基于已确认事实，在本地按岗位证据和相关线索初选、安排经历。正文保留事实原值，不生成业绩、项目数据或新的个人能力。
      </p>
      <p data-testid="resume-status" role="note">
        {message}
      </p>
      <label>
        简历目标岗位
        <select
          aria-label="简历目标岗位"
          value={job?.job_id ?? ''}
          disabled={busy || dirty}
          onChange={(e) => {
            setJobId(e.target.value);
            setResumeId('');
            setMessage('');
          }}
        >
          <option value="">暂无岗位</option>
          {career.jobs.map((j) => (
            <option key={j.job_id} value={j.job_id}>
              {j.attributes.find((a) => a.key === 'title')?.value ||
                j.source.title_hint ||
                '未命名岗位'}{' '}
              · v{j.revision}
              {j.reviewed ? '' : '（待核对）'}
            </option>
          ))}
        </select>
      </label>
      {!job?.reviewed && (
        <p className="small">先在上方 JD 匹配中保存岗位并核对提取项。</p>
      )}
      <label>
        新简历版本名称
        <input
          aria-label="新简历版本名称"
          maxLength={160}
          value={newName}
          disabled={busy}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="留空时按岗位命名"
        />
      </label>
      <div className="actions">
        <button
          disabled={
            busy ||
            !job?.reviewed ||
            !confirmedFacts(props.profile).length ||
            dirty
          }
          onClick={() => void work(() => generate())}
        >
          生成岗位版简历
        </button>
        {resume && (
          <button
            disabled={busy || !job?.reviewed || dirty}
            onClick={() => void work(() => generate(resume))}
          >
            基于最新资料生成独立新版本
          </button>
        )}
      </div>
      {resume && (
        <>
          <label>
            已保存岗位简历
            <select
              aria-label="已保存岗位简历"
              disabled={busy || dirty}
              value={resume.resume_id}
              onChange={(e) => setResumeId(e.target.value)}
            >
              {variants.map((r) => (
                <option key={r.resume_id} value={r.resume_id}>
                  {r.name} · v{r.revision}
                </option>
              ))}
            </select>
          </label>
          <p>
            岗位 v{resume.job_revision} · 档案 v{resume.profile_revision} · 截至{' '}
            {resume.as_of} ·{' '}
            {resume.status === 'approved' ? '已审核' : '待审核'}
          </p>
          {stale && (
            <p role="alert">
              简历已过期：岗位、资料、日期或规则已变化。原版本保留，请根据最新资料生成新版本并审核。
            </p>
          )}
          {dirty && <p role="note">存在未保存修改，保存后需重新审核。</p>}
          <div className="resume-columns">
            <div>
              <h3>选择与编排</h3>
              <p>
                选入 {selected.length} /{' '}
                {resume.blocks.flatMap((b) => b.facts).length}{' '}
                条事实。未选入经历仍可手动添加。
              </p>
              <label>
                当前简历名称
                <input
                  aria-label="当前简历名称"
                  maxLength={160}
                  value={name}
                  disabled={busy || stale}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <p className="small">
                需要改写内容时，请到下方事实库修改并确认，再生成新版本。相关线索用于初选和排列，不代表满足条件。性别、薪资、证书编号默认不选入。
              </p>
              <div className="resume-blocks">
                {order.map((id, index) => {
                  const block = resume.blocks.find((b) => b.block_id === id)!;
                  return (
                    <article
                      className="fact"
                      data-testid="resume-block"
                      key={id}
                    >
                      <h4>
                        {resumeCategoryNames[block.category]} · 第 {index + 1}{' '}
                        组
                      </h4>
                      <div className="actions">
                        <button
                          aria-label={`上移第 ${index + 1} 组`}
                          disabled={busy || stale || index === 0}
                          onClick={() => move(index, -1)}
                        >
                          上移
                        </button>
                        <button
                          aria-label={`下移第 ${index + 1} 组`}
                          disabled={busy || stale || index === order.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          下移
                        </button>
                      </div>
                      {block.facts.map((f) => (
                        <div
                          className="resume-fact"
                          key={f.fact_id}
                          data-testid="resume-fact"
                        >
                          <label className="check">
                            <input
                              type="checkbox"
                              aria-label={`选入${resumeFactLabels[f.path]}：${resumeValue(f)}`}
                              checked={selectedSet.has(f.fact_id)}
                              disabled={busy || stale}
                              onChange={(e) =>
                                setSelected(
                                  e.target.checked
                                    ? [...selected, f.fact_id]
                                    : selected.filter((id) => id !== f.fact_id),
                                )
                              }
                            />
                            {resumeFactLabels[f.path]}：
                            <span className="resume-value">
                              {resumeValue(f)}
                            </span>
                          </label>
                          <details>
                            <summary>查看事实和岗位引用</summary>
                            <p className="small">
                              {f.source_type === 'resume'
                                ? '简历原文'
                                : '用户确认'}{' '}
                              · 事实 v{f.fact_revision}
                            </p>
                            {typeof f.value !== 'string' && (
                              <p className="small">
                                日期精度：{f.value.precision}，没有补齐日期。
                              </p>
                            )}
                            {!f.evidences.length && (
                              <p className="small">
                                用户输入事实，没有原文材料引用。
                              </p>
                            )}
                            {f.source_type === 'user' &&
                              f.evidences.length > 0 && (
                                <p className="small">
                                  下列材料仅供对照，不证明用户修订后的值来自原文。
                                </p>
                              )}
                            {f.evidences.map((e) => (
                              <blockquote key={e.evidence_id}>
                                原始材料{e.page ? `（第 ${e.page} 页）` : ''}：
                                {e.quote}
                              </blockquote>
                            ))}
                            {f.relevance.map((rel) => (
                              <blockquote key={rel.requirement_id}>
                                {rel.kind === 'matched'
                                  ? '匹配证据'
                                  : '相关线索，需核实'}
                                ：
                                {
                                  resume.requirements.find(
                                    (r) =>
                                      r.requirement_id === rel.requirement_id,
                                  )?.quote
                                }
                              </blockquote>
                            ))}
                          </details>
                        </div>
                      ))}
                    </article>
                  );
                })}
              </div>
            </div>
            <div>
              <h3>简历正文预览</h3>
              <article className="resume-preview" data-testid="resume-preview">
                {resume.job_title && (
                  <p className="small">
                    求职岗位：{resume.job_title}
                    {resume.company ? ' · ' + resume.company : ''}
                  </p>
                )}
                {preview.map((block) => (
                  <section key={block.block_id}>
                    <h4>{resumeCategoryNames[block.category]}</h4>
                    {block.facts.map((f) => (
                      <p className="resume-value" key={f.fact_id}>
                        <strong>{resumeFactLabels[f.path]}：</strong>
                        {resumeValue(f)}
                      </p>
                    ))}
                  </section>
                ))}
                {!selected.length && <p>请至少选入一条已确认事实。</p>}
              </article>
              <p className="small">
                仅选入的事实会出现在正文；内部引用保存在资料库。可打印 HTML
                用浏览器打开后另存 PDF。
              </p>
            </div>
          </div>
          <div className="actions">
            <button
              disabled={
                busy || stale || !dirty || !selected.length || !name.trim()
              }
              onClick={() =>
                void work(() =>
                  edit({
                    name,
                    selected_fact_ids: selected,
                    block_order: order,
                  }),
                )
              }
            >
              保存简历编排
            </button>
            <button
              disabled={busy || !dirty}
              onClick={() => {
                setName(resume.name);
                setSelected(resume.selected_fact_ids);
                setOrder(resume.block_order);
              }}
            >
              放弃未保存修改
            </button>
            <button
              disabled={busy || stale || dirty || resume.status === 'approved'}
              onClick={() => void work(() => edit({ approve: true }))}
            >
              我已核对正文与来源，审核此版本
            </button>
            <button
              disabled={busy || stale || dirty || resume.status !== 'approved'}
              onClick={() => void work(() => download('markdown'))}
            >
              导出岗位简历 Markdown
            </button>
            <button
              disabled={busy || stale || dirty || resume.status !== 'approved'}
              onClick={() => void work(() => download('html'))}
            >
              导出可打印 HTML
            </button>
          </div>
          <details>
            <summary>简历修订历史（{resume.history.length}）</summary>
            <p className="small">
              v{resume.revision}：{resume.change_note}。最多保留 10
              个历史修订，恢复内容后仍需重新审核。
            </p>
            {[...resume.history].reverse().map((v) => (
              <article key={v.revision}>
                <p>
                  v{v.revision} · {v.name} · 选入 {v.selected_fact_ids.length}{' '}
                  条 · {v.status === 'approved' ? '当时已审核' : '待审核'}：
                  {v.change_note}
                </p>
                <button
                  disabled={busy || stale || dirty}
                  onClick={() =>
                    void work(() => edit({ restore_revision: v.revision }))
                  }
                >
                  恢复简历 v{v.revision} 的编排
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
                  resumes: (c.resumes ?? []).filter(
                    (r) => r.resume_id !== resume.resume_id,
                  ),
                }));
                if (alive.current) {
                  setResumeId('');
                  setMessage('此岗位简历及其修订历史已删除，原始资料保留');
                }
              })
            }
          >
            删除此岗位简历及修订
          </button>
        </>
      )}
      {!resume && (
        <p className="small">
          本地生成无需模型授权或 API
          连接。先确认个人资料，再为不同岗位生成独立简历。
        </p>
      )}
    </details>
  );
}
