import { ExecutionPanel } from './ExecutionPanel';
import { useEffect, useRef, useState } from 'react';
import { Value } from '@sinclair/typebox/value';
import {
  ScanDataSchema,
  sameExecutionScope,
  snapshotRef,
  canonicalJson,
  hashJson,
  planConsentPayload,
  type FormSnapshot,
  type FillPlanView,
  type FillPlanRequest,
  type FieldResolution,
  type PlanQuestion,
  type FieldValue,
  type LocalFillTask,
} from '@formpilot/contracts';
import { confirmedFacts, type ProfileState } from '@formpilot/domain';
import * as api from './api';
import { factLabels } from './labels';
const show = (v: unknown) =>
  v === null || v === ''
    ? '（空）'
    : typeof v === 'string'
      ? v
      : JSON.stringify(v);
const names = {
  fill: '可填',
  ask: '待补充',
  review: '需审核',
  manual: '人工处理',
  skip: '跳过',
};
const stateNames: Record<string, string> = {
  DRAFT: '草稿，需重新审核',
  PLANNED: '计划已生成',
  WAITING_USER: '等待补答或审核',
  READY: '已批准，可执行填写',
  WRITING: '正在执行已批准字段',
  REVIEW: '填写已结束，待核对',
};
const invalidNames: Record<string, string> = {
  PROFILE_CHANGED: '资料或解锁状态已变化',
  PAGE_CHANGED: '页面状态已变化',
  USER_CANCELLED: '任务已取消',
  USER_UNDONE: '已撤销，请重新生成并审核',
  EXECUTION_INTERRUPTED: '执行状态未确认，请检查页面',
};
const reasons: Record<string, string> = {
  CONFIRMED_FACT: '来自已确认资料',
  USER_TASK_ANSWER: '来自本任务补答或修改',
  OPTIONAL_EMPTY: '缺少可用资料，保留网页现状',
  MISSING_FACT: '缺少已确认资料，请补充',
  ALREADY_MATCHES: '网页原值已与资料一致',
  USER_KEEP_EXISTING: '按你的选择保留网页原值',
  USER_CANCELLED: '已取消此字段',
  USER_MANUAL: '已转为人工处理',
  CONTROL_MANUAL: '此控件需在网页中人工处理',
  PROHIBITED_OR_IRRELEVANT: '敏感或与申请无关的字段，跳过',
  OPTION_NOT_FOUND: '未找到对应选项，请核对',
  OPTION_AMBIGUOUS: '存在多个同名选项，请核对',
  VALUE_FORMAT: '值不符合网页格式要求',
  LENGTH_CONSTRAINT: '值不符合网页长度要求',
  RANGE_CONSTRAINT: '值超出网页允许范围',
  STEP_CONSTRAINT: '数值不符合网页步长要求',
  VALUE_TYPE_MISMATCH: '值类型与网页控件不匹配',
  BOOLEAN_REQUIRED: '请提供是或否',
  CURRENT_VALUE_CONFLICT: '网页原值与资料不同，需明确保留或替换',
  ENTITY_BINDING_REQUIRED: '请先选择本组对应的经历',
  DATE_PRECISION_REQUIRED: '资料日期精度不足，请提供准确日期',
  FACT_CONFLICT: '同一经历存在冲突事实',
  TIME_RANGE_ERROR: '结束早于开始，请核实日期',
  MODEL_DEGRADED: '模型不可用，规则候选需人工处理或补答',
  MODEL_MAPPING_REQUIRES_REVIEW: '请确认模型建议的字段含义',
  SEMANTIC_CONFLICT: '规则与模型判断不同，请确认字段含义',
  PATTERN_REQUIRES_REVIEW: '网页包含额外格式约束，请人工核实',
};
async function scan() {
  const response = await chrome.runtime.sendMessage({
    protocol_version: '1',
    request_id: crypto.randomUUID(),
    task_id: null,
    method: 'scan.get',
  });
  if (response.error || !Value.Check(ScanDataSchema, response.data))
    throw new Error('无法读取扫描，请在目标页面重新启动扫描');
  return response.data.snapshot as FormSnapshot | null;
}
function Question({
  q,
  busy,
  answer,
}: {
  q: PlanQuestion;
  busy: boolean;
  answer: (q: PlanQuestion, value: FieldValue) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <div className="plan-question">
      <label>
        {q.prompt}
        {q.answer_type === 'single' || q.answer_type === 'boolean' ? (
          <select
            aria-label={q.prompt}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          >
            <option value="">请选择</option>
            {q.answer_type === 'boolean' ? (
              <>
                <option value="true">是</option>
                <option value="false">否</option>
              </>
            ) : (
              q.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))
            )}
          </select>
        ) : (
          <input
            aria-label={q.prompt}
            type={
              q.answer_type === 'date'
                ? 'date'
                : q.answer_type === 'month'
                  ? 'month'
                  : 'text'
            }
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </label>
      {q.answer_type === 'multiple' && (
        <p className="small">
          多项选择请用英文逗号分隔：{q.options.map((o) => o.label).join('、')}
        </p>
      )}
      <button
        disabled={busy || value === ''}
        onClick={() =>
          answer(
            q,
            q.answer_type === 'boolean'
              ? value === 'true'
              : q.answer_type === 'multiple'
                ? value.split(',').map((s) => s.trim())
                : value,
          )
        }
      >
        保存本任务答案
      </button>
    </div>
  );
}
export function PlanPanel(props: {
  profile: ProfileState;
  session: api.ApiSession | null;
  updateTasks: (
    update: (tasks: LocalFillTask[]) => LocalFillTask[],
  ) => Promise<ProfileState>;
  fresh: () => Promise<ProfileState>;
}) {
  const latest = useRef(props);
  latest.current = props;
  const [snapshot, setSnapshot] = useState<FormSnapshot | null>(null);
  const [plan, setPlan] = useState<FillPlanView | null>(
    props.profile.fill_tasks?.at(-1)?.latest ?? null,
  );
  const planRef = useRef(plan);
  planRef.current = plan;
  const [invalid, setInvalid] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [consent, setConsent] = useState(false);
  const [caps, setCaps] = useState<Awaited<
    ReturnType<typeof api.capabilities>
  > | null>(null);
  const [selected, setSelected] = useState<string[]>(
      plan?.user_approval?.approved_field_ids ??
        plan?.field_decisions
          .filter((d) => d.decision === 'fill')
          .map((d) => d.field_id) ??
        [],
    ),
    [edits, setEdits] = useState<Record<string, string>>({});
  const consentFor = useRef('');
  useEffect(() => {
    setConsent(false);
    void api
      .capabilities()
      .then(setCaps)
      .catch(() => {});
  }, [props.session]);
  const alive = useRef(true),
    running = useRef(false),
    invalidating = useRef(false);
  useEffect(() => {
    alive.current = true;
    void api
      .capabilities()
      .then(setCaps)
      .catch(() => {});
    return () => {
      alive.current = false;
    };
  }, []);
  async function persist(view: FillPlanView) {
    if (!alive.current) return;
    const committed = await latest.current.updateTasks((tasks) => {
      const old = tasks.find((t) => t.task_id === view.task_id);
      const history =
        old &&
        (old.latest.plan_id !== view.plan_id ||
          old.latest.state_revision !== view.state_revision)
          ? [...old.history, old.latest].slice(-40)
          : (old?.history ?? []);
      return [
        ...tasks.filter((t) => t.task_id !== view.task_id),
        {
          task_id: view.task_id,
          latest: view,
          history,
          invalid_reason: view.invalid_reason,
          saved_at: Date.now(),
          ...(old?.executions ? { executions: old.executions } : {}),
        },
      ].slice(-30);
    });
    view = committed.fill_tasks!.find(
      (t) => t.task_id === view.task_id,
    )!.latest;
    if (!alive.current) return;
    setPlan(view);
    planRef.current = view;
    setSelected(
      view.user_approval?.approved_field_ids ??
        view.field_decisions
          .filter((d) => d.decision === 'fill')
          .map((d) => d.field_id),
    );
  }
  async function invalidate(reason: string, target = planRef.current) {
    setInvalid(reason);
    setMessage('资料或页面已变化，批准已失效');
    setConsent(false);
    if (invalidating.current || !target || target.invalid_reason) return;
    invalidating.current = true;
    const p = target,
      s = latest.current.session;
    try {
      const view = s
        ? await api.planOperation(
            'invalidate',
            {
              schema_version: 1,
              client_request_id: crypto.randomUUID(),
              task_id: p.task_id,
              plan_id: p.plan_id,
              expected_plan_revision: p.plan_revision,
              reason,
            } as Parameters<typeof api.planOperation>[1],
            s,
          )
        : {
            ...p,
            status: 'DRAFT' as const,
            state_revision: p.state_revision + 1,
            user_approval: null,
            invalid_reason: reason,
          };
      await persist(view);
    } catch {
      setMessage('旧计划已在本地阻止批准；请连接 API 后重新生成计划');
    } finally {
      invalidating.current = false;
    }
  }
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const snap = await scan();
        if (cancelled) return;
        setSnapshot(snap);
        const p = planRef.current;
        if (p && !p.invalid_reason) {
          const fresh = await latest.current.fresh();
          if (fresh.profile_revision !== p.profile_revision)
            await invalidate('PROFILE_CHANGED');
          else if (
            !snap ||
            (['WRITING', 'REVIEW'].includes(p.status)
              ? !sameExecutionScope(snapshotRef(snap), p.snapshot_ref)
              : canonicalJson(snapshotRef(snap)) !==
                canonicalJson(p.snapshot_ref))
          )
            await invalidate('PAGE_CHANGED');
        }
      } catch {
        if (!cancelled && planRef.current) {
          setInvalid('PAGE_CHANGED');
          setMessage('扫描或资料库状态已变化，请重新解锁并扫描');
        }
      }
    }
    void refresh();
    const timer = setInterval(() => {
      if (!running.current) void refresh();
    }, 1800);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    setConsent(false);
    if (
      planRef.current &&
      props.profile.profile_revision !== planRef.current.profile_revision
    ) {
      setInvalid('PROFILE_CHANGED');
    }
  }, [props.profile.profile_revision]);
  async function work(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (e) {
      if (alive.current)
        setMessage(e instanceof Error ? e.message : '计划操作失败');
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function guarded(p: FillPlanView) {
    const current = await latest.current.fresh(),
      snap = await scan();
    if (current.profile_revision !== p.profile_revision) {
      await invalidate('PROFILE_CHANGED', p);
      throw new Error('资料已变化，请重新生成');
    }
    if (
      !snap ||
      canonicalJson(snapshotRef(snap)) !== canonicalJson(p.snapshot_ref)
    ) {
      await invalidate('PAGE_CHANGED', p);
      throw new Error('页面已变化，请重新生成');
    }
    return { current, snap };
  }
  function resolve(
    resolutions: FieldResolution[] = [],
    answers: unknown[] = [],
  ) {
    void work(async () => {
      const p = planRef.current,
        s = latest.current.session;
      if (!p || !s) throw new Error('请连接 API');
      await guarded(p);
      const view = await api.planOperation(
        'resolve',
        {
          schema_version: 1,
          client_request_id: crypto.randomUUID(),
          task_id: p.task_id,
          plan_id: p.plan_id,
          expected_plan_revision: p.plan_revision,
          resolutions,
          answers,
        } as Parameters<typeof api.planOperation>[1],
        s,
      );
      await guarded(view);
      await persist(view);
      setMessage('已生成新版本，旧批准失效');
    });
  }
  async function generate() {
    const s = latest.current.session;
    if (!s || !caps?.planning_available || !consent)
      throw new Error('请连接支持 M3 的 API 并确认本次上传');
    const p = await latest.current.fresh(),
      snap = await scan();
    if (!snap) throw new Error('请先在招聘页面点击扩展并开始扫描');
    if (
      consentFor.current !==
      canonicalJson([snapshotRef(snap), p.profile_revision])
    ) {
      setConsent(false);
      throw new Error('数据已变化，请重新勾选本次上传同意');
    }
    const facts = confirmedFacts(p).map(
      ({
        fact_id,
        fact_revision,
        profile_revision,
        category,
        path,
        value,
        entity_id,
        confirmation,
        source_type,
        evidence_ids,
        document_id,
      }) => ({
        fact_id,
        fact_revision,
        profile_revision,
        category,
        path,
        value,
        entity_id,
        confirmation: confirmation as 'confirmed',
        source_type,
        evidence_ids,
        document_id,
      }),
    );
    const ids = new Set(facts.flatMap((f) => f.evidence_ids)),
      entityIds = new Set(facts.map((f) => f.entity_id));
    const old = p.fill_tasks?.find((t) => t.task_id === snap.task_id)?.latest;
    const base = {
      schema_version: 1 as const,
      client_request_id: crypto.randomUUID(),
      task_id: snap.task_id,
      expected_plan_revision: old?.plan_revision ?? 0,
      profile_revision: p.profile_revision,
      form_snapshot: snap,
      confirmed_facts: facts,
      entities: p.entities.filter((e) => entityIds.has(e.entity_id)),
      evidences: p.evidences.filter((e) => ids.has(e.evidence_id)),
      task_answers: [],
    };
    const request: FillPlanRequest = {
      ...base,
      consent: {
        granted: true,
        purpose: 'fill_plan',
        provider: caps.provider,
        model: caps.model,
        policy_url: caps.policy_url,
        payload_hash: await hashJson(planConsentPayload(base)),
        granted_at: Date.now(),
      },
    };
    setConsent(false);
    const view = await api.planOperation('plan', request, s);
    await guarded(view);
    await persist(view);
    setInvalid(null);
    setMessage(
      view.degraded
        ? '模型降级：候选需审核，任务答案仍可手动补充'
        : '计划已生成，请逐项审核',
    );
  }
  const blocked =
    busy || plan?.status === 'WRITING' || !!invalid || !!plan?.invalid_reason;
  const sourceSnapshot =
    snapshot?.form_snapshot_id === plan?.form_snapshot_id ? snapshot : null;
  return (
    <section className="plan-panel">
      <h2>M3 · 填充计划审核</h2>
      <p>
        先在招聘页面点击扩展图标启动扫描，再回到这里生成计划。批准后可执行填写并查看回读报告。
      </p>
      <p data-testid="plan-status">
        {message ||
          (plan?.status === 'READY'
            ? '已批准，可执行填写'
            : plan
              ? stateNames[plan.status]
              : '尚未生成计划')}
      </p>
      {(invalid || plan?.invalid_reason) && (
        <p role="alert">
          计划已失效：
          {invalidNames[invalid || plan?.invalid_reason || ''] ??
            '计划上下文已变化'}
          。请重新扫描并生成。
        </p>
      )}
      <p>
        当前扫描：
        {snapshot
          ? `${snapshot.origin} · ${snapshot.fields.length} 个字段`
          : '未启动或已过期'}
        ；可用事实 {confirmedFacts(props.profile).length} 条。
      </p>
      <details>
        <summary>本次数据与模型服务</summary>
        <p>
          本地 API
          接收扫描快照、已确认事实及对应证据；模型仅接收字段（含标签、原值、选项）、分组和经历名称，用于语义判断。模型不生成填写值。供应商：
          {caps?.provider || '未连接'}；模型：{caps?.model || '未知'}。
        </p>
        {caps?.policy_url && (
          <a href={caps.policy_url} target="_blank" rel="noreferrer">
            查看供应商数据政策
          </a>
        )}
        <pre>
          {snapshot
            ? JSON.stringify(
                {
                  fields: snapshot.fields.map((f) => ({
                    label: f.label,
                    current_value: f.current_value,
                  })),
                  facts: confirmedFacts(props.profile).map((f) => ({
                    path: f.path,
                    value: f.value,
                  })),
                },
                null,
                2,
              )
            : '请先扫描'}
        </pre>
      </details>
      <label>
        <input
          type="checkbox"
          checked={consent}
          disabled={busy}
          onChange={(e) => {
            setConsent(e.target.checked);
            consentFor.current = snapshot
              ? canonicalJson([
                  snapshotRef(snapshot),
                  props.profile.profile_revision,
                ])
              : '';
          }}
        />
        同意本次向所示供应商发送字段数据生成计划
      </label>
      <div className="actions">
        <button
          disabled={
            busy ||
            !consent ||
            !snapshot ||
            !props.session ||
            !caps?.planning_available
          }
          onClick={() => void work(generate)}
        >
          {busy ? '处理中…' : '生成填充计划'}
        </button>
        {plan && (
          <button
            disabled={busy || !props.session}
            onClick={() =>
              void work(async () => {
                const view = await api.getPlan(
                  plan.task_id,
                  latest.current.session!,
                );
                await persist(view);
                await guarded(view);
                setInvalid(view.invalid_reason);
              })
            }
          >
            同步已保存计划
          </button>
        )}
      </div>
      {plan && (
        <>
          <ExecutionPanel
            key={plan.task_id}
            plan={plan}
            profile={props.profile}
            session={props.session}
            fresh={props.fresh}
            updateTasks={props.updateTasks}
            scan={scan}
            onPlan={(view) => {
              setPlan(view);
              planRef.current = view;
              setInvalid(view.invalid_reason);
            }}
          />
          <p>
            版本 {plan.plan_revision} · 档案 v{plan.profile_revision} ·{' '}
            {plan.degraded ? '规则降级' : '模型辅助'} · 耗时{' '}
            {Math.round(plan.duration_ms)} ms
          </p>
          <details>
            <summary>版本摘要与批准记录</summary>
            <pre>
              {JSON.stringify(
                {
                  plan_id: plan.plan_id,
                  digest: plan.plan_digest,
                  approval: plan.user_approval,
                  history: props.profile.fill_tasks
                    ?.find((t) => t.task_id === plan.task_id)
                    ?.history.map((v) => ({
                      revision: v.plan_revision,
                      status: v.status,
                      approval: v.user_approval?.approval_id,
                    })),
                },
                null,
                2,
              )}
            </pre>
          </details>
          {plan.questions.map((q) => (
            <Question
              key={plan.plan_id + q.question_id}
              q={q}
              busy={blocked}
              answer={(q, value) =>
                resolve(
                  [],
                  [
                    {
                      question_id: q.question_id,
                      value,
                      precision:
                        q.answer_type === 'date'
                          ? 'day'
                          : q.answer_type === 'month'
                            ? 'month'
                            : null,
                      scope: 'task',
                    },
                  ],
                )
              }
            />
          ))}
          <div className="plan-decisions">
            {plan.field_decisions.map((d) => {
              const field = sourceSnapshot?.fields.find(
                (f) => f.field_id === d.field_id,
              );
              return (
                <article
                  className="fact"
                  key={d.field_id}
                  data-testid="plan-field"
                >
                  <strong>{d.field_label}</strong>
                  <span className="pill">{names[d.decision]}</span>
                  <p>
                    {d.semantic_path ? factLabels[d.semantic_path] : ''} ·{' '}
                    {reasons[d.reason_code] ?? '请核实此项后继续'}
                  </p>
                  <p>
                    网页原值：{show(d.current_value)} → 建议值：
                    {show(d.target_value ?? d.candidate_value)}
                  </p>
                  <p className="small">
                    来源：
                    {d.fact_refs
                      .map((f) => `已确认资料 v${f.fact_revision}`)
                      .join('、')}
                    {d.answer_refs.length ? ' · 用户本任务答案' : ''}
                    {d.entity_id
                      ? ' · ' +
                        (props.profile.entities.find(
                          (e) => e.entity_id === d.entity_id,
                        )?.label ?? '本任务经历')
                      : ''}
                  </p>
                  {d.evidence_ids.map((id) => (
                    <blockquote key={id}>
                      {
                        props.profile.evidences.find(
                          (e) => e.evidence_id === id,
                        )?.quote
                      }
                    </blockquote>
                  ))}
                  {d.decision === 'fill' && (
                    <label>
                      <input
                        type="checkbox"
                        disabled={blocked || plan.status === 'READY'}
                        checked={selected.includes(d.field_id)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, d.field_id]
                              : selected.filter((id) => id !== d.field_id),
                          )
                        }
                      />
                      纳入本次批准
                    </label>
                  )}
                  <div className="actions">
                    <button
                      disabled={busy || plan.status === 'WRITING'}
                      onClick={() =>
                        void work(async () => {
                          const snap = await scan();
                          if (
                            !snap ||
                            !sameExecutionScope(
                              snapshotRef(snap),
                              plan.snapshot_ref,
                            )
                          )
                            throw new Error('页面已变化，请重新扫描');
                          const response = await chrome.runtime.sendMessage({
                            protocol_version: '1',
                            request_id: crypto.randomUUID(),
                            task_id: plan.task_id,
                            method: 'scan.locate',
                            ref: snapshotRef(snap),
                            field_id: d.field_id,
                          });
                          if (response.error)
                            throw new Error(
                              '无法定位该字段，请在网页中人工查找',
                            );
                          setMessage('已定位网页字段，可在网页中人工处理');
                        })
                      }
                    >
                      定位到网页
                    </button>
                    {d.reason_code === 'CURRENT_VALUE_CONFLICT' && (
                      <>
                        <button
                          disabled={blocked}
                          onClick={() =>
                            resolve([{ type: 'keep', field_id: d.field_id }])
                          }
                        >
                          保留网页原值
                        </button>
                        <button
                          disabled={blocked}
                          onClick={() =>
                            resolve([{ type: 'replace', field_id: d.field_id }])
                          }
                        >
                          确认替换为建议值
                        </button>
                      </>
                    )}
                    {d.reason_code === 'SEMANTIC_CONFLICT' &&
                      d.semantic_path && (
                        <button
                          disabled={blocked}
                          onClick={() =>
                            resolve([
                              {
                                type: 'map_field',
                                field_id: d.field_id,
                                path: d.semantic_path!,
                              },
                            ])
                          }
                        >
                          确认此字段含义
                        </button>
                      )}
                    <button
                      disabled={blocked}
                      onClick={() =>
                        resolve([{ type: 'manual', field_id: d.field_id }])
                      }
                    >
                      转人工
                    </button>
                    <button
                      disabled={blocked}
                      onClick={() =>
                        resolve([{ type: 'cancel', field_id: d.field_id }])
                      }
                    >
                      取消此项
                    </button>
                  </div>
                  {field?.supported && (
                    <details>
                      <summary>修改本任务值</summary>
                      <label>
                        新值
                        <input
                          aria-label={'修改 ' + (field.label || d.field_id)}
                          type={
                            field.control_type === 'date'
                              ? 'date'
                              : field.control_type === 'month'
                                ? 'month'
                                : 'text'
                          }
                          value={edits[d.field_id] ?? ''}
                          onChange={(e) =>
                            setEdits({ ...edits, [d.field_id]: e.target.value })
                          }
                        />
                      </label>
                      <button
                        disabled={blocked || !edits[d.field_id]}
                        onClick={() =>
                          resolve([
                            {
                              type: 'edit',
                              field_id: d.field_id,
                              value: edits[d.field_id]!,
                              precision:
                                field.control_type === 'date'
                                  ? 'day'
                                  : field.control_type === 'month'
                                    ? 'month'
                                    : null,
                            },
                          ])
                        }
                      >
                        保存本任务修改
                      </button>
                      <p className="small">
                        只保存在本任务。需要复用时，请在资料库新增或编辑事实并确认。
                      </p>
                    </details>
                  )}
                </article>
              );
            })}
          </div>
          <button
            disabled={
              blocked ||
              !props.session ||
              selected.length === 0 ||
              plan.status === 'READY' ||
              plan.field_decisions.some((d) => d.decision === 'review')
            }
            onClick={() =>
              void work(async () => {
                const { current, snap } = await guarded(plan);
                const view = await api.planOperation(
                  'approve',
                  {
                    schema_version: 1,
                    client_request_id: crypto.randomUUID(),
                    task_id: plan.task_id,
                    plan_id: plan.plan_id,
                    expected_plan_revision: plan.plan_revision,
                    plan_digest: plan.plan_digest,
                    approved_field_ids: selected,
                    observed_profile_revision: current.profile_revision,
                    observed_snapshot_ref: snapshotRef(snap),
                    observed_at: Date.now(),
                  } as Parameters<typeof api.planOperation>[1],
                  latest.current.session!,
                );
                await guarded(view);
                await persist(view);
                setMessage('已批准，可执行填写。尚未填写或提交申请');
              })
            }
          >
            批准所选 {selected.length} 项
          </button>
          <p className="small">
            批准仅针对此版本和所选字段；缺项、人工项仍需处理。页面或资料变化后必须重新审核。
          </p>
        </>
      )}
    </section>
  );
}
