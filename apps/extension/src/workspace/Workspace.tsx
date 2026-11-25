import { AnswerPanel } from './AnswerPanel';
import { ResumePanel } from './ResumePanel';
import { CareerPanel } from './CareerPanel';
import { PlanPanel } from './PlanPanel';
import { factLabels, parseErrors } from './labels';
import { useState, useEffect, useRef } from 'react';
import {
  PATHS,
  type FactValue,
  type FactPath,
  type LocalFillTask,
  type CareerState,
} from '@formpilot/contracts';
import {
  currentFacts,
  confirmedFacts,
  importExtraction,
  reviseFact,
  addManualFact,
  displayValue,
  factConflicts,
  anomalies,
  mergeEntities,
  type ProfileState,
  type Fact,
  type Document,
} from '@formpilot/domain';
import { Vault, hashText } from '@formpilot/local-store';
import { importFile, importText } from './import';
import * as api from './api';
import './workspace.css';
const vault = new Vault();
const categoryNames: Record<string, string> = {
  basic: '基本信息',
  education: '教育经历',
  work: '工作经历',
  internship: '实习经历',
  project: '项目经历',
  skill: '专业技能',
  certificate: '证书',
  intention: '求职意向',
};
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请重试';
function download(name: string, contents: string, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function FactCard({
  fact,
  profile,
  busy,
  change,
}: {
  fact: Fact;
  profile: ProfileState;
  busy: boolean;
  change: (
    id: string,
    change: Partial<Pick<Fact, 'value' | 'confirmation'>>,
  ) => void;
}) {
  const [text, setText] = useState(displayValue(fact.value));
  const [precision, setPrecision] = useState(
    typeof fact.value === 'string' ? '' : fact.value.precision,
  );
  const evidence = profile.evidences.filter((e) =>
    fact.evidence_ids.includes(e.evidence_id),
  );
  const conflicts = factConflicts(profile, fact);
  return (
    <article className="fact" data-fact-path={fact.path}>
      <div className="fact-title">
        <strong>{factLabels[fact.path]}</strong>
        <span className={'pill ' + fact.confirmation}>
          {fact.confirmation === 'pending'
            ? '待确认'
            : fact.confirmation === 'confirmed'
              ? '已确认'
              : '已拒绝'}{' '}
          · v{fact.fact_revision}
        </span>
      </div>
      <label>
        事实值
        <input
          aria-label="事实值"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {precision && (
        <label>
          日期精度
          <select
            value={precision}
            onChange={(e) => setPrecision(e.target.value)}
          >
            <option value="year">年</option>
            <option value="month">年月</option>
            <option value="day">年月日</option>
            <option value="present">至今（值为 present）</option>
          </select>
        </label>
      )}
      <p className="small">
        来源：{fact.source_type === 'resume' ? '简历原文' : '用户输入'}
        {fact.note ? ' · ' + fact.note : ''}
      </p>
      {evidence.map((e) => (
        <blockquote key={e.evidence_id}>
          <span>{e.page ? '第 ' + e.page + ' 页' : '文本'} · 原文证据</span>
          <mark>{e.quote}</mark>
          <details>
            <summary>查看所在原文块</summary>
            <pre>
              {
                profile.documents
                  .find((d) => d.document_id === e.document_id)
                  ?.blocks.find((b) => b.block_id === e.block_id)?.text
              }
            </pre>
            <small>
              偏移 {e.start}–{e.end}
            </small>
          </details>
        </blockquote>
      ))}
      {!!conflicts.length && (
        <p className="warning">
          存在 {conflicts.length} 条不同值候选：
          {conflicts.map((f) => displayValue(f.value)).join(' / ')}
          。请明确保留或拒绝，不会自动覆盖。
        </p>
      )}
      <div className="row">
        <button
          disabled={busy}
          onClick={() =>
            change(fact.fact_id, {
              value: precision ? { value: text, precision } : text,
            })
          }
        >
          保存修改
        </button>
        <button
          className="primary"
          disabled={busy || fact.confirmation === 'confirmed'}
          onClick={() => change(fact.fact_id, { confirmation: 'confirmed' })}
        >
          确认事实
        </button>
        <button
          className="quiet"
          disabled={busy || fact.confirmation === 'rejected'}
          onClick={() => change(fact.fact_id, { confirmation: 'rejected' })}
        >
          拒绝
        </button>
      </div>
      <details>
        <summary>
          历史版本（
          {profile.facts.filter((f) => f.fact_id === fact.fact_id).length}）
        </summary>
        {profile.facts
          .filter((f) => f.fact_id === fact.fact_id)
          .map((f) => (
            <p key={f.fact_revision} className="small">
              v{f.fact_revision} · {displayValue(f.value)} · {f.confirmation} ·{' '}
              {f.source_type} · {f.created_at}
            </p>
          ))}
      </details>
    </article>
  );
}
export function Workspace() {
  const [profile, setProfile] = useState<ProfileState | null>(null);
  const [exists, setExists] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const epoch = useRef(0);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [caps, setCaps] = useState<Awaited<
    ReturnType<typeof api.capabilities>
  > | null>(null);
  const [apiToken, setApiToken] = useState('');
  const [session, setSession] = useState<api.ApiSession | null>(null);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [deleteText, setDeleteText] = useState('');
  const [manualPath, setManualPath] = useState<FactPath>('basic.name');
  const [manualValue, setManualValue] = useState('');
  const [manualPrecision, setManualPrecision] = useState('month');
  const [manualEntity, setManualEntity] = useState('');
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const channel = useRef<BroadcastChannel | null>(null);
  function lock(broadcast = true) {
    epoch.current++;
    vault.lock();
    setProfile(null);
    setSession(null);
    setPassword('');
    setRepeat('');
    setText('');
    setSelected(null);
    setConsent(false);
    setApiToken('');
    setOldPassword('');
    setNewPassword('');
    setDeleteText('');
    setManualValue('');
    setMergeTargets({});
    if (broadcast) channel.current?.postMessage('lock');
  }
  useEffect(() => {
    void vault.exists().then(setExists);
    channel.current = new BroadcastChannel('formpilot-vault-lock');
    channel.current.onmessage = () => {
      lock(false);
      void vault.exists().then(setExists);
    };
    const hide = () => lock(false);
    window.addEventListener('pagehide', hide);
    return () => {
      channel.current?.close();
      window.removeEventListener('pagehide', hide);
      vault.lock();
    };
  }, []);
  const isUnlocked = profile !== null;
  useEffect(() => {
    if (!isUnlocked) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          lock();
          setMessage('静置 15 分钟，资料库已锁定');
        },
        15 * 60 * 1000,
      );
    };
    reset();
    window.addEventListener('pointerdown', reset);
    window.addEventListener('keydown', reset);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', reset);
      window.removeEventListener('keydown', reset);
    };
  }, [isUnlocked]);
  async function run(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function commit(next: ProfileState) {
    const currentEpoch = epoch.current;
    const saved = await vault.save(next);
    if (currentEpoch !== epoch.current || !vault.unlocked)
      throw new Error('资料库已锁定');
    setProfile(saved);
  }
  async function updateTasks(
    update: (tasks: LocalFillTask[]) => LocalFillTask[],
  ) {
    const currentEpoch = epoch.current,
      saved = await vault.updateTasks(update);
    if (currentEpoch !== epoch.current || !vault.unlocked)
      throw new Error('资料库已锁定');
    setProfile(saved);
    return saved;
  }
  async function updateCareer(
    change: (state: CareerState, profile: ProfileState) => CareerState,
  ) {
    const currentEpoch = epoch.current,
      saved = await vault.updateCareer(change);
    if (currentEpoch !== epoch.current || !vault.unlocked)
      throw new Error('资料库已锁定');
    setProfile(saved);
    return saved;
  }
  async function open() {
    const state = exists
      ? await vault.unlock(password)
      : await vault.create(password);
    setPassword('');
    setRepeat('');
    setProfile(state);
    setExists(true);
    setSelected(state.documents[0]?.document_id ?? null);
    const saved = await api.loadSession(state.workspace_id);
    if (vault.unlocked) setSession(saved);
  }
  async function add(doc: Document) {
    if (!profile) throw new Error('请先解锁');
    if (profile.documents.some((d) => d.content_hash === doc.content_hash))
      throw new Error('该文档已导入；重复文件不会静默合并');
    if (profile.documents.length >= 20) throw new Error('最多保留 20 份文档');
    await commit({
      ...profile,
      profile_revision: profile.profile_revision + 1,
      documents: [...profile.documents, doc],
    });
    setSelected(doc.document_id);
    setConsent(false);
    setText('');
    setMessage('已在本地加密保存；尚未发送给模型');
  }
  async function connect() {
    if (!profile) return;
    const value = await api.capabilities();
    setCaps(value);
    setConsent(false);
    if (!value.model_available)
      throw new Error('服务端模型或本地访问令牌未配置');
    let active = await api.loadSession(profile.workspace_id);
    if (!active) {
      if (!apiToken) throw new Error('请填写服务端 .env 中的本地访问令牌');
      active = await api.createSession(profile.workspace_id, apiToken);
    }
    setApiToken('');
    if (vault.unlocked) setSession(active);
    setMessage('解析服务已连接；只有勾选授权后才发送文本');
  }
  async function parse(doc: Document, resume = false) {
    if (!profile || !session || !caps) throw new Error('请先连接解析服务');
    if (!resume && !consent) throw new Error('请先确认本次模型处理授权');
    let state = structuredClone(profile);
    const local = state.documents.find(
      (d) => d.document_id === doc.document_id,
    )!;
    const currentEpoch = epoch.current;
    const ensure = () => {
      if (epoch.current !== currentEpoch || !vault.unlocked)
        throw new Error('资料库已锁定；解锁后可恢复任务');
    };
    try {
      let job: Awaited<ReturnType<typeof api.startParse>>;
      if (resume && doc.job_id) job = await api.pollParse(doc.job_id, session);
      else {
        const blocks_hash = await hashText(JSON.stringify(doc.blocks));
        local.status = 'running';
        local.error = null;
        local.client_request_id =
          resume && doc.client_request_id
            ? doc.client_request_id
            : crypto.randomUUID();
        local.consent_hash = blocks_hash;
        const granted = resume
          ? doc.parse_consent
          : {
              granted: true as const,
              purpose: 'resume_parse' as const,
              provider: caps.provider,
              model: caps.model,
              policy_url: caps.policy_url,
              blocks_hash,
              granted_at: Date.now(),
            };
        if (
          !granted ||
          granted.blocks_hash !== blocks_hash ||
          granted.provider !== caps.provider ||
          granted.model !== caps.model ||
          granted.policy_url !== caps.policy_url
        )
          throw new Error('解析授权或配置已变化，请重新勾选授权');
        local.parse_consent = granted;
        await commit(state);
        ensure();
        job = await api.startParse(
          {
            client_request_id: local.client_request_id,
            document_id: doc.document_id,
            document_revision: 1,
            source_blocks: doc.blocks,
            consent: granted,
          },
          session,
        );
      }
      ensure();
      local.job_id = job.job_id;
      local.status = 'running';
      await commit(state);
      for (
        let attempt = 0;
        job.status === 'running' && attempt < 65;
        attempt++
      ) {
        ensure();
        setMessage('正在解析，任务已保存在本地；关闭页面后可解锁恢复查询');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        ensure();
        job = await api.pollParse(job.job_id, session);
      }
      ensure();
      if (job.status !== 'succeeded' || !job.result)
        throw new Error(
          parseErrors[job.error_code ?? ''] ?? '解析超时，请稍后恢复查询',
        );
      state = importExtraction(state, doc.document_id, job.result.extraction);
      state.measurements.push({
        document_id: doc.document_id,
        provider: job.result.provider,
        model: job.result.model,
        ...job.result.usage,
        duration_ms: job.result.duration_ms,
      });
      await commit(state);
      setConsent(false);
      setMessage('解析完成，所有事实均待确认；请逐项对照原文');
      try {
        await api.deleteJob(job.job_id, session);
      } catch {
        setMessage('解析结果已在本地保存；服务端短期结果将在五分钟内自动清理');
      }
    } catch (error) {
      if (vault.unlocked && epoch.current === currentEpoch) {
        const failed = structuredClone(state);
        const d = failed.documents.find(
          (d) => d.document_id === doc.document_id,
        )!;
        d.status = 'failed';
        d.error = errorText(error);
        await commit(failed);
      }
      throw error;
    }
  }
  const document = profile?.documents.find((d) => d.document_id === selected);
  const facts = profile ? currentFacts(profile) : [];
  const dateManual =
    manualPath.endsWith('_date') || manualPath === 'certificate.date';
  return (
    <div className="workspace">
      <header className="workspace-header">
        <div>
          <strong>FormPilot</strong>
          <span>个人经历资料库</span>
        </div>
        {profile && (
          <button
            onClick={() => {
              lock();
              setMessage('资料库已锁定');
            }}
          >
            锁定资料库
          </button>
        )}
      </header>
      <main className="workspace-main">
        <div className="workspace-heading">
          <span className="badge">M1 · 本地工作空间</span>
          <h1>让每条经历都有依据</h1>
          <p>导入简历，对照原文确认事实，建立可追溯的个人资料。</p>
        </div>
        {message && (
          <div className="notice" role="status">
            {message}
          </div>
        )}
        {!profile ? (
          <section className="unlock">
            <h2>{exists ? '解锁资料库' : '建立加密资料库'}</h2>
            <p>
              口令仅用于本地加密，不发送给模型。忘记口令无法恢复；请保存加密备份。
            </p>
            <label>
              资料库口令
              <input
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {!exists && (
              <label>
                再次输入口令
                <input
                  type="password"
                  autoComplete="off"
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                />
              </label>
            )}
            <button
              className="primary"
              disabled={busy || exists === null}
              onClick={() =>
                void run(async () => {
                  if (!exists && password !== repeat)
                    throw new Error('两次口令不一致');
                  await open();
                })
              }
            >
              {exists ? '解锁' : '建立资料库'}
            </button>
            {!exists && (
              <label>
                从加密备份恢复
                <input
                  type="file"
                  accept=".json"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file)
                      void run(async () => {
                        if (file.size > 80000000) throw new Error('备份过大');
                        await vault.restore(await file.text(), password);
                        setExists(true);
                        setPassword('');
                        setRepeat('');
                        setMessage('备份已恢复，请使用备份口令解锁');
                      });
                  }}
                />
              </label>
            )}
          </section>
        ) : (
          <>
            <div className="workspace-stats">
              <div>
                <strong>{profile.documents.length}</strong> 份文档
              </div>
              <div>
                <strong>{confirmedFacts(profile).length}</strong>{' '}
                条可用已确认事实
              </div>
              <div>
                <strong>
                  {facts.filter((f) => f.confirmation === 'pending').length}
                </strong>{' '}
                条待确认
              </div>
              <div>
                档案版本 <strong>{profile.profile_revision}</strong>
              </div>
            </div>
            <CareerPanel
              profile={profile}
              session={session}
              fresh={() => vault.readCurrent()}
              updateCareer={updateCareer}
            />
            <AnswerPanel
              profile={profile}
              session={session}
              fresh={() => vault.readCurrent()}
              updateCareer={updateCareer}
            />
            <ResumePanel
              profile={profile}
              fresh={() => vault.readCurrent()}
              updateCareer={updateCareer}
            />
            <PlanPanel
              profile={profile}
              session={session}
              updateTasks={updateTasks}
              fresh={() => vault.readCurrent()}
            />
            <div className="workspace-columns">
              <div>
                <section>
                  <h2>导入简历</h2>
                  <p className="small">
                    支持 PDF（文字版）、UTF-8 TXT
                    或手动输入。文件先保存到本地加密仓库，扫描件不自动 OCR。
                  </p>
                  <label>
                    选择 PDF 或 TXT
                    <input
                      type="file"
                      accept=".pdf,.txt"
                      disabled={busy}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file)
                          void run(async () => {
                            const doc = await importFile(file);
                            await add(doc);
                          });
                      }}
                    />
                  </label>
                  <label>
                    粘贴简历原文
                    <textarea
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      rows={6}
                    />
                  </label>
                  <button
                    disabled={busy || !text.trim()}
                    onClick={() =>
                      void run(async () => add(await importText(text)))
                    }
                  >
                    保存手动文本
                  </button>
                </section>
                <section>
                  <h2>文档与原文</h2>
                  {profile.documents.length === 0 ? (
                    <p>还没有导入文档。</p>
                  ) : (
                    <>
                      <label>
                        选择文档
                        <select
                          value={selected ?? ''}
                          onChange={(e) => {
                            setSelected(e.target.value);
                            setConsent(false);
                          }}
                        >
                          {profile.documents.map((d) => (
                            <option key={d.document_id} value={d.document_id}>
                              {d.name} · {d.status}
                            </option>
                          ))}
                        </select>
                      </label>
                      {document && (
                        <>
                          <p className="small">
                            {document.mime} · {document.blocks.length} 个原文块
                            · SHA-256 {document.content_hash.slice(0, 12)}…
                          </p>
                          {document.error && (
                            <p className="warning">{document.error}</p>
                          )}
                          <details>
                            <summary>查看完整提取文本</summary>
                            {document.blocks.map((b) => (
                              <div key={b.block_id}>
                                <small>
                                  {b.page ? '第 ' + b.page + ' 页' : '文本'} ·
                                  偏移 {b.start}–{b.end}
                                </small>
                                <pre>{b.text}</pre>
                              </div>
                            ))}
                          </details>
                        </>
                      )}
                    </>
                  )}
                </section>
                <section>
                  <h2>模型解析授权</h2>
                  <p className="small">
                    本地访问令牌来自服务端
                    .env，用于建立短期会话；这不是模型密钥。会话保存在浏览器会话存储，浏览器重启后失效。
                  </p>
                  <label>
                    本地 API 访问令牌
                    <input
                      type="password"
                      autoComplete="off"
                      value={apiToken}
                      onChange={(e) => setApiToken(e.target.value)}
                    />
                  </label>
                  <button disabled={busy} onClick={() => void run(connect)}>
                    连接解析服务
                  </button>
                  {caps && (
                    <>
                      <p>
                        供应商：{caps.provider || '未配置'}
                        <br />
                        模型：{caps.model || '未配置'}
                      </p>
                      {caps.policy_url && (
                        <a
                          href={caps.policy_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          查看供应商数据处理政策
                        </a>
                      )}
                    </>
                  )}
                  {document && session && caps && (
                    <>
                      <p className="small">
                        本次发送：选中文档提取的{' '}
                        {document.blocks.reduce((n, b) => n + b.text.length, 0)}{' '}
                        个字符和块标识。原文件、其他文档与已保存资料不会随请求发送。供应商按其政策处理数据，具体保留期限请查看政策。
                      </p>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={consent}
                          onChange={(e) => setConsent(e.target.checked)}
                        />
                        我同意将当前文档提取文本发送给上述供应商，用于生成待确认事实。
                      </label>
                      <button
                        className="primary"
                        disabled={
                          busy || !consent || document.status === 'parsed'
                        }
                        onClick={() => void run(() => parse(document))}
                      >
                        授权并解析当前文档
                      </button>
                      {(document.job_id || document.status === 'running') && (
                        <button
                          disabled={busy}
                          onClick={() => void run(() => parse(document, true))}
                        >
                          恢复解析任务
                        </button>
                      )}
                    </>
                  )}
                </section>
                <section>
                  <h2>手动补充事实</h2>
                  <p className="small">
                    手动输入同样需要确认，来源明确标记为用户输入。
                  </p>
                  <label>
                    事实字段
                    <select
                      value={manualPath}
                      onChange={(e) => {
                        setManualPath(e.target.value as FactPath);
                        setManualEntity('');
                      }}
                    >
                      {PATHS.map((p) => (
                        <option key={p} value={p}>
                          {factLabels[p]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    补充值
                    <input
                      value={manualValue}
                      onChange={(e) => setManualValue(e.target.value)}
                    />
                  </label>
                  {dateManual && (
                    <label>
                      补充日期精度
                      <select
                        value={manualPrecision}
                        onChange={(e) => setManualPrecision(e.target.value)}
                      >
                        <option value="year">年</option>
                        <option value="month">年月</option>
                        <option value="day">年月日</option>
                        <option value="present">至今（present）</option>
                      </select>
                    </label>
                  )}
                  <label>
                    归属经历
                    <select
                      value={manualEntity}
                      onChange={(e) => setManualEntity(e.target.value)}
                    >
                      <option value="">新建经历 / 基本信息归入已有实体</option>
                      {profile.entities
                        .filter((e) => e.category === manualPath.split('.')[0])
                        .map((e) => (
                          <option key={e.entity_id} value={e.entity_id}>
                            {e.label}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    disabled={busy || !manualValue.trim()}
                    onClick={() =>
                      void run(async () => {
                        const value: FactValue = dateManual
                          ? { value: manualValue, precision: manualPrecision }
                          : manualValue;
                        await commit(
                          addManualFact(
                            profile,
                            manualPath,
                            value,
                            manualEntity || null,
                          ),
                        );
                        setManualValue('');
                        setMessage('已添加待确认事实');
                      })
                    }
                  >
                    添加待确认事实
                  </button>
                </section>
              </div>
              <div>
                <section>
                  <h2>事实审核</h2>
                  <p className="small">
                    原文候选不会自动确认。修改形成新版本并标记为用户来源；原证据继续保留供对照。
                  </p>
                  {anomalies(profile).map((item) => (
                    <p className="warning" key={item}>
                      {item}
                    </p>
                  ))}
                  {profile.entities
                    .filter((entity) =>
                      facts.some((f) => f.entity_id === entity.entity_id),
                    )
                    .map((entity) => (
                      <div key={entity.entity_id} className="entity">
                        <h3>
                          {categoryNames[entity.category]} · {entity.label}
                        </h3>
                        {profile.entities.some(
                          (e) =>
                            e.category === entity.category &&
                            e.entity_id !== entity.entity_id,
                        ) && (
                          <div className="merge">
                            <select
                              aria-label={'映射经历 ' + entity.label}
                              value={mergeTargets[entity.entity_id] ?? ''}
                              onChange={(e) =>
                                setMergeTargets({
                                  ...mergeTargets,
                                  [entity.entity_id]: e.target.value,
                                })
                              }
                            >
                              <option value="">
                                将该组事实映射至已有同类经历…
                              </option>
                              {profile.entities
                                .filter(
                                  (e) =>
                                    e.category === entity.category &&
                                    e.entity_id !== entity.entity_id,
                                )
                                .map((e) => (
                                  <option key={e.entity_id} value={e.entity_id}>
                                    {e.label}
                                  </option>
                                ))}
                            </select>
                            <button
                              disabled={busy || !mergeTargets[entity.entity_id]}
                              onClick={() =>
                                void run(async () => {
                                  await commit(
                                    mergeEntities(
                                      profile,
                                      entity.entity_id,
                                      mergeTargets[entity.entity_id]!,
                                    ),
                                  );
                                  setMessage(
                                    '已重新绑定整组事实，全部恢复为待确认',
                                  );
                                })
                              }
                            >
                              确认映射
                            </button>
                          </div>
                        )}
                        {facts
                          .filter((f) => f.entity_id === entity.entity_id)
                          .map((f) => (
                            <FactCard
                              key={f.fact_id + ':' + f.fact_revision}
                              fact={f}
                              profile={profile}
                              busy={busy}
                              change={(id, change) =>
                                void run(async () => {
                                  await commit(reviseFact(profile, id, change));
                                  setMessage(
                                    change.confirmation === 'confirmed'
                                      ? '事实已确认'
                                      : '已保存新版本',
                                  );
                                })
                              }
                            />
                          ))}
                      </div>
                    ))}
                  {!facts.length && (
                    <div className="empty">
                      导入并解析简历，或手动添加第一条事实。
                    </div>
                  )}
                </section>
              </div>
            </div>
            <section>
              <h2>备份与隐私管理</h2>
              <p>
                备份包含所有原文、事实和历史的密文。恢复需要原口令。关闭此页面或手动锁定后清除内存中的解密密钥；静置
                15 分钟自动锁定。
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    download(
                      'formpilot-encrypted-backup.json',
                      await vault.backup(),
                    );
                    setMessage('加密备份已导出');
                  })
                }
              >
                导出加密备份
              </button>
              <details>
                <summary>修改资料库口令</summary>
                <label>
                  原口令
                  <input
                    type="password"
                    autoComplete="off"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                  />
                </label>
                <label>
                  新口令
                  <input
                    type="password"
                    autoComplete="off"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </label>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await vault.changePassword(oldPassword, newPassword);
                      lock();
                      setMessage('口令已更新，请使用新口令解锁');
                    })
                  }
                >
                  更新口令并锁定
                </button>
              </details>
              <details>
                <summary>删除全部资料</summary>
                <p className="warning">
                  删除原文件、原文块、事实、证据、历史与本地任务；无法恢复。已导出的备份不受影响。供应商已处理的数据需要按其政策管理。
                </p>
                <label>
                  输入 DELETE 确认删除
                  <input
                    value={deleteText}
                    onChange={(e) => setDeleteText(e.target.value)}
                  />
                </label>
                <button
                  className="danger"
                  disabled={busy || deleteText !== 'DELETE'}
                  onClick={() =>
                    void run(async () => {
                      let cleaned = false;
                      if (session) {
                        try {
                          await api.revokeSession(
                            profile.workspace_id,
                            session,
                          );
                          cleaned = true;
                        } catch {
                          cleaned = false;
                          await chrome.storage.session.remove(
                            'api_' + profile.workspace_id,
                          );
                        }
                      }
                      await vault.deleteAll();
                      lock();
                      setExists(false);
                      setMessage(
                        cleaned
                          ? '本地资料与服务端任务已删除'
                          : '本地资料已删除；未确认服务端清理。解析结果五分钟过期，计划最多保留 24 小时',
                      );
                    })
                  }
                >
                  删除全部资料
                </button>
              </details>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
