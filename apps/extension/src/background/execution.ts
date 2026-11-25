import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import {
  API_ORIGIN,
  SessionSchema,
  ExecutionViewSchema,
  BrowserExecutionStateSchema,
  ExecutionJournalMessageSchema,
  ScanSessionSchema,
  isExecutionUiMessage,
  sameExecutionScope,
  failure,
  type ExecutionUiMessage,
  type ExecutionJournalMessage,
  type ErrorCode,
} from '@formpilot/contracts';
const metaKey = 'execution_session_v1';
const MetaSchema = Type.Object(
  {
    workspace_id: Type.String({ pattern: '^[a-zA-Z0-9-]{1,64}$' }),
    task_id: Type.String({ pattern: '^[a-zA-Z0-9-]{1,64}$' }),
    execution_id: Type.String({ pattern: '^[a-zA-Z0-9-]{1,64}$' }),
    tab_id: Type.Integer({ minimum: 0 }),
    execution_epoch: Type.Integer({ minimum: 1 }),
    expires_at: Type.Integer(),
  },
  { additionalProperties: false },
);
type Meta = import('@sinclair/typebox').Static<typeof MetaSchema>;
class ExecutionFault extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}
const guards = new Map<
  chrome.runtime.Port,
  {
    workspace: string;
    pending: Map<
      string,
      { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }
    >;
  }
>();
const optionsSender = (sender: chrome.runtime.MessageSender) =>
  sender.id === chrome.runtime.id &&
  sender.url === chrome.runtime.getURL('options.html');
chrome.runtime.onConnect.addListener((port) => {
  if (
    port.name !== 'formpilot-execution-guard' ||
    !port.sender ||
    !optionsSender(port.sender)
  ) {
    port.disconnect();
    return;
  }
  const state = {
    workspace: '',
    pending: new Map<
      string,
      { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }
    >(),
  };
  guards.set(port, state);
  port.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const m = message as {
      method?: unknown;
      workspace_id?: unknown;
      request_id?: unknown;
      ok?: unknown;
    };
    if (
      m.method === 'register' &&
      typeof m.workspace_id === 'string' &&
      /^[a-zA-Z0-9-]{1,64}$/.test(m.workspace_id)
    ) {
      state.workspace = m.workspace_id;
      return;
    }
    if (m.method === 'guard.result' && typeof m.request_id === 'string') {
      const pending = state.pending.get(m.request_id);
      if (pending) {
        clearTimeout(pending.timer);
        state.pending.delete(m.request_id);
        pending.resolve(m.ok === true);
      }
    }
  });
  port.onDisconnect.addListener(() => {
    guards.delete(port);
    for (const p of state.pending.values()) {
      clearTimeout(p.timer);
      p.resolve(false);
    }
    state.pending.clear();
  });
});
async function guard(workspace: string, revision: number) {
  const entry = [...guards].find(([, state]) => state.workspace === workspace);
  if (!entry) throw new ExecutionFault('UNAUTHORIZED');
  const [port, state] = entry,
    id = crypto.randomUUID();
  const ok = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      resolve(false);
    }, 2500);
    state.pending.set(id, { resolve, timer });
    try {
      port.postMessage({
        method: 'guard',
        request_id: id,
        workspace_id: workspace,
        profile_revision: revision,
      });
    } catch {
      clearTimeout(timer);
      state.pending.delete(id);
      resolve(false);
    }
  });
  if (!ok) throw new ExecutionFault('STALE_PLAN');
}
async function request(
  workspace: string,
  path: string,
  body?: { client_request_id: string; [key: string]: unknown },
) {
  const session = (await chrome.storage.session.get('api_' + workspace))[
    'api_' + workspace
  ];
  if (!Value.Check(SessionSchema, session) || session.expires_at < Date.now())
    throw new ExecutionFault('UNAUTHORIZED');
  let response: Response;
  try {
    response = await fetch(API_ORIGIN + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + session.session_token,
        ...(body
          ? {
              'Content-Type': 'application/json',
              'Idempotency-Key': body.client_request_id,
            }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(7000),
      cache: 'no-store',
      redirect: 'error',
    });
  } catch {
    throw new ExecutionFault('SERVICE_UNAVAILABLE');
  }
  const envelope = (await response.json()) as {
    data: unknown;
    error: { code: ErrorCode } | null;
  };
  if (!response.ok || envelope.error)
    throw new ExecutionFault(envelope.error?.code ?? 'SERVICE_UNAVAILABLE');
  return envelope.data;
}
async function execution(workspace: string, task: string, id: string) {
  const rows = await request(
    workspace,
    '/v1/fill/tasks/' + encodeURIComponent(task) + '/executions',
  );
  if (!Array.isArray(rows)) throw new ExecutionFault('INVALID_REQUEST');
  const row = rows.find(
    (e) => Value.Check(ExecutionViewSchema, e) && e.packet.execution_id === id,
  );
  if (!Value.Check(ExecutionViewSchema, row))
    throw new ExecutionFault('REFERENCE_NOT_FOUND');
  return row;
}
async function meta() {
  const raw = (await chrome.storage.session.get(metaKey))[metaKey];
  return Value.Check(MetaSchema, raw) ? raw : null;
}
async function send(
  m: Meta,
  method: string,
  extra: Record<string, unknown> = {},
) {
  const response = await chrome.tabs
    .sendMessage(
      m.tab_id,
      {
        protocol_version: '1',
        request_id: crypto.randomUUID(),
        task_id: m.task_id,
        method,
        ...(method === 'execution.run' ? {} : { execution_id: m.execution_id }),
        ...extra,
      },
      { frameId: 0 },
    )
    .catch(() => {
      throw new ExecutionFault('PAGE_CHANGED');
    });
  if (!response || response.error)
    throw new ExecutionFault(response?.error?.code ?? 'PAGE_CHANGED');
  return response.data as unknown;
}
async function perform(message: ExecutionUiMessage) {
  const e = await execution(
      message.workspace_id,
      message.task_id,
      message.execution_id,
    ),
    p = e.packet;
  const m: Meta = {
    workspace_id: message.workspace_id,
    task_id: message.task_id,
    execution_id: message.execution_id,
    tab_id: p.snapshot_ref.tab_id,
    execution_epoch: p.execution_epoch,
    expires_at: p.expires_at,
  };
  if (message.method === 'execution.start') {
    if (e.phase !== 'created' || p.expires_at < Date.now())
      throw new ExecutionFault('STALE_PLAN');
    await guard(m.workspace_id, p.profile_revision);
    const scan = (await chrome.storage.session.get('scan_session_v1'))
      .scan_session_v1;
    if (
      !Value.Check(ScanSessionSchema, scan) ||
      scan.task_id !== m.task_id ||
      scan.tab_id !== m.tab_id ||
      scan.expires_at < Date.now()
    )
      throw new ExecutionFault('SNAPSHOT_EXPIRED');
    const existing = await meta();
    if (
      existing &&
      existing.execution_id !== m.execution_id &&
      existing.expires_at > Date.now()
    ) {
      try {
        const old = await execution(
          existing.workspace_id,
          existing.task_id,
          existing.execution_id,
        );
        if (!['completed', 'interrupted'].includes(old.phase))
          throw new ExecutionFault('EXECUTION_LOCKED');
      } catch (error) {
        if (
          error instanceof ExecutionFault &&
          error.code === 'EXECUTION_LOCKED'
        )
          throw error;
      }
    }
    await chrome.storage.session.set({ [metaKey]: m });
    const result = await send(m, 'execution.run', {
      workspace_id: m.workspace_id,
      packet: p,
      started_at: e.report.started_at,
    });
    if (!Value.Check(BrowserExecutionStateSchema, result))
      throw new ExecutionFault('INVALID_REQUEST');
    return result;
  }
  if (message.method === 'execution.cancel') {
    await request(m.workspace_id, '/v1/fill/executions/cancel', {
      schema_version: 1,
      client_request_id: crypto.randomUUID(),
      task_id: m.task_id,
      execution_id: m.execution_id,
    });
    return send(m, 'execution.stop');
  }
  if (message.method === 'execution.interrupt') {
    try {
      const state = await send(m, 'execution.read');
      if (Value.Check(BrowserExecutionStateSchema, state) && state.running)
        throw new ExecutionFault('EXECUTION_LOCKED');
    } catch (error) {
      if (error instanceof ExecutionFault && error.code === 'EXECUTION_LOCKED')
        throw error;
    }
    const result = await request(
      m.workspace_id,
      '/v1/fill/executions/interrupt',
      {
        schema_version: 1,
        client_request_id: crypto.randomUUID(),
        task_id: m.task_id,
        execution_id: m.execution_id,
      },
    );
    await chrome.storage.session.remove(metaKey);
    return result;
  }
  return send(m, 'execution.read');
}
async function journal(
  message: ExecutionJournalMessage,
  sender: chrome.runtime.MessageSender,
) {
  const m = await meta(),
    body = message.checkpoint;
  if (
    !m ||
    sender.id !== chrome.runtime.id ||
    sender.tab?.id !== m.tab_id ||
    sender.frameId !== 0 ||
    m.workspace_id !== message.workspace_id ||
    m.task_id !== message.task_id ||
    body.task_id !== m.task_id ||
    body.execution_id !== m.execution_id ||
    body.execution_epoch !== m.execution_epoch
  )
    throw new ExecutionFault('SCOPE_DENIED');
  const e = await execution(m.workspace_id, m.task_id, m.execution_id);
  if (body.lease_token !== e.packet.lease_token)
    throw new ExecutionFault('SCOPE_DENIED');
  if (
    body.phase === 'before' &&
    !sameExecutionScope(body.observed_snapshot_ref, e.packet.snapshot_ref)
  )
    throw new ExecutionFault('PAGE_CHANGED');
  if (['before', 'after', 'completed'].includes(body.phase)) {
    try {
      await guard(m.workspace_id, e.packet.profile_revision);
    } catch (error) {
      try {
        await request(m.workspace_id, '/v1/fill/invalidate', {
          schema_version: 1,
          client_request_id: crypto.randomUUID(),
          task_id: m.task_id,
          plan_id: e.packet.plan_id,
          expected_plan_revision: e.packet.plan_revision,
          reason: 'PROFILE_CHANGED',
        });
      } catch {
        /* Already invalidated or offline. */
      }
      if (body.phase === 'before') throw error;
    }
  }
  const result = await request(
    m.workspace_id,
    '/v1/fill/executions/checkpoint',
    body,
  );
  if (!Value.Check(ExecutionViewSchema, result))
    throw new ExecutionFault('INVALID_REQUEST');
  return result;
}
let queue: Promise<unknown> = Promise.resolve();
export function handleExecutionMessage(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (v: unknown) => void,
): boolean | undefined {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('method' in raw) ||
    typeof raw.method !== 'string' ||
    !raw.method.startsWith('execution.')
  )
    return undefined;
  const id =
    'request_id' in raw && typeof raw.request_id === 'string'
      ? raw.request_id
      : 'invalid';
  if (Value.Check(ExecutionJournalMessageSchema, raw)) {
    void journal(raw, sender)
      .then((data) => respond({ request_id: id, data, error: null }))
      .catch((error) =>
        respond(
          failure(
            id,
            error instanceof ExecutionFault
              ? error.code
              : 'EXECUTION_INTERRUPTED',
            '执行检查点未确认，停止后续填写',
          ),
        ),
      );
    return true;
  }
  if (!optionsSender(sender) || !isExecutionUiMessage(raw)) {
    respond(failure(id, 'SCOPE_DENIED', '此来源不能执行填写'));
    return false;
  }
  const work = queue.then(() => perform(raw));
  queue = work.catch(() => undefined);
  void work
    .then((data) => respond({ request_id: id, data, error: null }))
    .catch((error) =>
      respond(
        failure(
          id,
          error instanceof ExecutionFault
            ? error.code
            : 'EXECUTION_INTERRUPTED',
          '执行未启动或已中断，请核对页面与资料状态',
        ),
      ),
    );
  return true;
}

// Stopping or replacing a scan also ends its write authority, including after navigation.
export async function stopExecutionForScan(task_id: string, tab_id: number) {
  const m = await meta();
  if (!m || m.task_id !== task_id || m.tab_id !== tab_id) return;
  try {
    await send(m, 'execution.stop');
  } catch {
    /* The old document may already be gone. */
  }
  try {
    const e = await execution(m.workspace_id, m.task_id, m.execution_id);
    if (!['completed', 'interrupted'].includes(e.phase))
      await request(m.workspace_id, '/v1/fill/executions/interrupt', {
        schema_version: 1,
        client_request_id: crypto.randomUUID(),
        task_id: m.task_id,
        execution_id: m.execution_id,
      });
    await chrome.storage.session.remove(metaKey);
  } catch {
    /* Keep recovery metadata when the API is offline; the server lock still expires. */
  }
}
