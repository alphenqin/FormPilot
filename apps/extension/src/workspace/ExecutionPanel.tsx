import { useEffect, useRef, useState } from 'react';
import {
  canonicalJson,
  snapshotRef,
  sameExecutionScope,
  type FillPlanView,
  type ExecutionView,
  type FormSnapshot,
  type BeginExecution,
  type LocalFillTask,
} from '@formpilot/contracts';
import type { ProfileState } from '@formpilot/domain';
import * as api from './api';
const text = (value: unknown) =>
  value === null
    ? '未知'
    : typeof value === 'string'
      ? value || '（空）'
      : JSON.stringify(value);
const errors: Record<string, string> = {
  USER_CHANGED: '用户已修改，保护该字段',
  PAGE_CHANGED: '页面结构或身份变化，需重新扫描',
  STALE_SNAPSHOT: '页面值已变化，请重新审核',
  VALUE_NOT_PERSISTED: '写入后值被页面清空或改写',
  SITE_VALIDATION_FAILED: '网页校验未通过',
  CONTROL_UNSUPPORTED: '此控件需要人工操作',
  EXECUTION_INTERRUPTED: '执行中断或状态未确认，请核对页面',
  LOCATOR_NOT_FOUND: '字段已消失或替换',
  EXECUTION_EXPIRED: '执行授权已过期',
  SNAPSHOT_EXPIRED: '扫描已过期，请重新扫描',
};
type Props = {
  plan: FillPlanView;
  profile: ProfileState;
  session: api.ApiSession | null;
  fresh: () => Promise<ProfileState>;
  updateTasks: (
    update: (tasks: LocalFillTask[]) => LocalFillTask[],
  ) => Promise<ProfileState>;
  scan: () => Promise<FormSnapshot | null>;
  onPlan: (p: FillPlanView) => void;
};
async function command(
  method: string,
  workspace_id: string,
  task_id: string,
  execution_id: string,
) {
  const response = await chrome.runtime.sendMessage({
    protocol_version: '1',
    request_id: crypto.randomUUID(),
    task_id,
    method,
    workspace_id,
    execution_id,
  });
  if (response.error)
    throw new Error(
      errors[response.error.code] ?? response.error.message ?? '执行状态不可用',
    );
  return response.data;
}
export function ExecutionPanel(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const [rows, setRows] = useState<ExecutionView[]>(
      props.profile.fill_tasks?.find((t) => t.task_id === props.plan.task_id)
        ?.executions ?? [],
    ),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const running = useRef(false),
    alive = useRef(true),
    refreshing = useRef(false),
    lastSaved = useRef('');
  useEffect(() => {
    alive.current = true;
    let port: chrome.runtime.Port | null = null,
      timer: ReturnType<typeof setTimeout> | undefined,
      closed = false;
    function connect() {
      if (closed) return;
      try {
        port = chrome.runtime.connect({ name: 'formpilot-execution-guard' });
        port.postMessage({
          method: 'register',
          workspace_id: latest.current.profile.workspace_id,
        });
        port.onMessage.addListener(
          (m: {
            method?: string;
            request_id?: string;
            workspace_id?: string;
            profile_revision?: number;
          }) => {
            if (m.method !== 'guard' || !m.request_id) return;
            const target = port;
            void latest.current
              .fresh()
              .then((p) => {
                try {
                  target?.postMessage({
                    method: 'guard.result',
                    request_id: m.request_id,
                    ok:
                      !closed &&
                      p.workspace_id === m.workspace_id &&
                      p.profile_revision === m.profile_revision,
                  });
                } catch {
                  /* disconnected */
                }
              })
              .catch(() => {
                try {
                  target?.postMessage({
                    method: 'guard.result',
                    request_id: m.request_id,
                    ok: false,
                  });
                } catch {
                  /* disconnected */
                }
              });
          },
        );
        port.onDisconnect.addListener(() => {
          if (!closed) timer = setTimeout(connect, 600);
        });
      } catch {
        timer = setTimeout(connect, 600);
      }
    }
    connect();
    return () => {
      closed = true;
      alive.current = false;
      if (timer) clearTimeout(timer);
      port?.disconnect();
    };
  }, []);
  async function save(data: ExecutionView[], view: FillPlanView) {
    if (!alive.current) return;
    setRows(data);
    const signature = canonicalJson([
      view.plan_id,
      view.state_revision,
      data.map((e) => [
        e.packet.execution_id,
        e.sequence,
        e.phase,
        e.cancelled,
        e.verify_result,
      ]),
    ]);
    if (signature === lastSaved.current) return;
    const committed = await latest.current.updateTasks((tasks) => {
      const old = tasks.find((t) => t.task_id === view.task_id);
      if (!old) throw new Error('请先保存当前计划');
      return tasks.map((t) =>
        t.task_id !== view.task_id
          ? t
          : {
              ...t,
              latest: view,
              executions: data.slice(-20),
              invalid_reason: view.invalid_reason,
              saved_at: Date.now(),
            },
      );
    });
    const saved = committed.fill_tasks!.find(
      (t) => t.task_id === view.task_id,
    )!;
    view = saved.latest;
    setRows(saved.executions ?? []);
    if (!alive.current) return;
    lastSaved.current = signature;
    latest.current.onPlan(view);
  }
  async function refresh() {
    const { session, plan } = latest.current;
    if (!session || refreshing.current) return;
    refreshing.current = true;
    try {
      let data = await api.executions(plan.task_id, session),
        view = await api.getPlan(plan.task_id, session);
      const recent = data.at(-1);
      if (
        recent &&
        ['completed', 'interrupted'].includes(recent.phase) &&
        recent.packet.action !== 'undo' &&
        !recent.verify_result &&
        !view.invalid_reason &&
        view.user_approval &&
        recent.packet.plan_id === view.plan_id
      ) {
        try {
          await api.verifyExecution(
            {
              schema_version: 1,
              client_request_id: crypto.randomUUID(),
              task_id: view.task_id,
              plan_id: view.plan_id,
              plan_revision: view.plan_revision,
              form_snapshot_id: view.form_snapshot_id,
              user_approval: view.user_approval,
              execution_report: recent.report,
            },
            session,
          );
          data = await api.executions(plan.task_id, session);
          view = await api.getPlan(plan.task_id, session);
        } catch {
          if (alive.current)
            setMessage('浏览器报告已保存，服务端核验未确认；可刷新状态重试');
        }
      }
      if (data.length) await save(data, view);
      if (
        alive.current &&
        recent &&
        ['completed', 'interrupted'].includes(recent.phase)
      )
        setMessage((previous) =>
          /^(正在|已请求停止)/.test(previous)
            ? recent.packet.action === 'undo'
              ? '撤销已结束，请核对逐字段结果'
              : '填写已结束，请核对逐字段结果；申请尚未提交'
            : previous,
        );
    } catch (e) {
      if (alive.current)
        setMessage(e instanceof Error ? e.message : '无法同步执行状态');
    } finally {
      refreshing.current = false;
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!running.current) void refresh();
    }, 1200);
    return () => clearInterval(timer);
  }, [props.session, props.plan.task_id]);
  async function work(fn: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (e) {
      if (alive.current)
        setMessage(e instanceof Error ? e.message : '操作失败');
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function begin(
    action: BeginExecution['action'],
    source: ExecutionView | null = null,
    field?: string,
  ) {
    const { session, plan } = latest.current;
    if (!session) throw new Error('请先连接本地 API');
    const fresh = await latest.current.fresh(),
      snapshot = await latest.current.scan();
    if (fresh.profile_revision !== plan.profile_revision)
      throw new Error('资料已变化，请重新生成并批准计划');
    if (
      !snapshot ||
      !sameExecutionScope(snapshotRef(snapshot), plan.snapshot_ref)
    )
      throw new Error('页面已变化，请重新扫描');
    if (
      action === 'fill' &&
      canonicalJson(snapshotRef(snapshot)) !== canonicalJson(plan.snapshot_ref)
    )
      throw new Error('网页原值已变化，请重新审核');
    const field_ids =
      action === 'fill'
        ? (plan.user_approval?.approved_field_ids ?? [])
        : action === 'retry'
          ? [field!]
          : (source?.written_field_ids ?? []);
    const e = await api.executionOperation(
      'executions/begin',
      {
        schema_version: 1,
        client_request_id: crypto.randomUUID(),
        task_id: plan.task_id,
        plan_id: plan.plan_id,
        expected_plan_revision: plan.plan_revision,
        plan_digest: plan.plan_digest,
        action,
        source_execution_id: source?.packet.execution_id ?? null,
        field_ids,
        observed_profile_revision: fresh.profile_revision,
        observed_snapshot_ref: snapshotRef(snapshot),
        observed_at: Date.now(),
      },
      session,
    );
    const view = await api.getPlan(plan.task_id, session);
    await save(await api.executions(plan.task_id, session), view);
    try {
      await command(
        'execution.start',
        fresh.workspace_id,
        plan.task_id,
        e.packet.execution_id,
      );
      setMessage(
        action === 'undo'
          ? '正在逐项检查并撤销'
          : '正在填写已批准字段，完成后会自动回读核验',
      );
    } catch (error) {
      setMessage(
        '启动未确认，请点击“核对执行状态”。' +
          (error instanceof Error ? error.message : ''),
      );
    }
    await refresh();
  }
  const current = rows.filter((r) => r.packet.plan_id === props.plan.plan_id),
    recent = current.at(-1),
    active = recent && !['completed', 'interrupted'].includes(recent.phase);
  const pending = busy || !!active;
  return (
    <section className="execution-panel">
      <h3>M4 · 填写与核验</h3>
      <p>
        只填写当前版本中已批准的字段。完成后请核对页面；系统不会点击提交申请。
      </p>
      <p data-testid="execution-status" role="note">
        {message ||
          (active
            ? '填写进行中'
            : recent
              ? '本次操作已结束，请查看逐字段报告'
              : '批准计划后可开始填写')}
      </p>
      <div className="actions">
        <button
          disabled={
            pending ||
            !props.session ||
            props.plan.status !== 'READY' ||
            !!props.plan.invalid_reason
          }
          onClick={() => void work(() => begin('fill'))}
        >
          填写已批准字段
        </button>
        <button
          disabled={busy || !props.session}
          onClick={() => void work(refresh)}
        >
          刷新填写状态
        </button>
        {active && (
          <>
            <button
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  await command(
                    'execution.cancel',
                    props.profile.workspace_id,
                    props.plan.task_id,
                    recent.packet.execution_id,
                  );
                  await refresh();
                  setMessage('已请求停止，已写入的字段可逐项核对或撤销');
                })
              }
            >
              停止后续填写
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  try {
                    const state = await command(
                      'execution.status',
                      props.profile.workspace_id,
                      props.plan.task_id,
                      recent.packet.execution_id,
                    );
                    if (state.running) {
                      setMessage('当前页面仍在执行，保持资料库解锁并等待');
                      return;
                    }
                  } catch {
                    /* Lost page memory, no automatic writes. */
                  }
                  await command(
                    'execution.interrupt',
                    props.profile.workspace_id,
                    props.plan.task_id,
                    recent.packet.execution_id,
                  );
                  await refresh();
                  setMessage(
                    '执行已标记中断，未自动重放。请检查页面后重新扫描审核',
                  );
                })
              }
            >
              核对执行状态
            </button>
          </>
        )}
      </div>
      {current.length > 1 && (
        <details>
          <summary>历史执行记录（每次报告独立）</summary>
          {current
            .slice(0, -1)
            .reverse()
            .map((row) => (
              <article className="fact" key={row.packet.execution_id}>
                <strong>
                  {row.packet.action === 'undo' ? '撤销' : '填写'} ·{' '}
                  {new Date(row.report.started_at).toLocaleString()}
                </strong>
                <p>
                  {
                    row.report.field_results.filter(
                      (f) => f.status === 'verified',
                    ).length
                  }{' '}
                  项回读一致；
                  {
                    row.report.field_results.filter(
                      (f) => f.status === 'failed',
                    ).length
                  }{' '}
                  项待处理
                </p>
                {row.report.field_results.map((f) => (
                  <p key={f.field_id}>
                    {
                      row.packet.items.find(
                        (i) => i.field.field_id === f.field_id,
                      )?.field.label
                    }
                    ：{text(f.actual)} ·{' '}
                    {f.status === 'verified'
                      ? '本次回读一致'
                      : (errors[f.error_code ?? ''] ?? '需核对')}
                  </p>
                ))}
                {row.packet.action !== 'undo' &&
                  row.written_field_ids.length > 0 && (
                    <button
                      disabled={
                        pending ||
                        current.some(
                          (other) =>
                            other.packet.source_execution_id ===
                              row.packet.execution_id &&
                            other.packet.action === 'undo',
                        )
                      }
                      onClick={() => void work(() => begin('undo', row))}
                    >
                      撤销这次记录
                    </button>
                  )}
              </article>
            ))}
        </details>
      )}
      {recent && (
        <>
          <p>
            {recent.packet.action === 'undo' ? '撤销' : '填写'}报告：
            {
              recent.report.field_results.filter((f) => f.status === 'verified')
                .length
            }{' '}
            项{recent.packet.action === 'undo' ? '已恢复' : '回读一致'}，
            {
              recent.report.field_results.filter((f) => f.status === 'failed')
                .length
            }{' '}
            项待处理；
            {recent.packet.action === 'undo'
              ? '撤销结果已保存'
              : recent.verify_result
                ? '服务端已核对报告'
                : '服务端报告尚待核对'}
            。申请尚未提交。
          </p>
          <div className="execution-results">
            {recent.report.field_results.map((row) => (
              <article className="fact" key={row.field_id}>
                <strong>
                  {recent.packet.items.find(
                    (i) => i.field.field_id === row.field_id,
                  )?.field.label ?? '字段'}
                </strong>
                <p>
                  {row.status === 'verified'
                    ? recent.packet.action === 'undo'
                      ? '已恢复原值'
                      : '稳定回读一致'
                    : (errors[row.error_code ?? ''] ?? '请人工核对')}
                </p>
                <p>
                  原值：{text(row.before)} → 目标：{text(row.target)}；回读：
                  {text(row.actual)}
                </p>
                {recent.packet.action !== 'undo' && row.status === 'failed' && (
                  <button
                    disabled={
                      pending ||
                      !!props.plan.invalid_reason ||
                      props.plan.status !== 'REVIEW'
                    }
                    onClick={() =>
                      void work(() => begin('retry', recent, row.field_id))
                    }
                  >
                    重试此字段
                  </button>
                )}
              </article>
            ))}
          </div>
          {recent.packet.action !== 'undo' &&
            recent.written_field_ids.length > 0 && (
              <button
                disabled={pending || !props.session}
                onClick={() => void work(() => begin('undo', recent))}
              >
                撤销本次填写
              </button>
            )}
          <p className="small">
            撤销只恢复仍等于本次写入值且未被后来编辑的字段。页面重载或执行记忆丢失时需人工处理；撤销不能删除网站可能已自动保存的数据。
          </p>
        </>
      )}
    </section>
  );
}
