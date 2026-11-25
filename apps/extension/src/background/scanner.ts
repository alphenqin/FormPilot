import { stopExecutionForScan } from './execution';
import { Value } from '@sinclair/typebox/value';
import {
  isScanUiMessage,
  ScanDataSchema,
  LocateResultSchema,
  ScanSessionSchema,
  failure,
  type ScanUiMessage,
  type ScanSession,
  type ScanData,
  type ErrorCode,
} from '@formpilot/contracts';
const key = 'scan_session_v1';
class ScanFault extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly userMessage: string,
  ) {
    super(userMessage);
  }
}
async function savedSession(): Promise<ScanSession | null> {
  const stored = (await chrome.storage.session.get(key))[key];
  return Value.Check(ScanSessionSchema, stored) ? stored : null;
}
function trustedSender(sender: chrome.runtime.MessageSender) {
  if (sender.id !== chrome.runtime.id) return false;
  try {
    const url = new URL(sender.url ?? '');
    return (
      url.protocol === 'chrome-extension:' &&
      url.host === chrome.runtime.id &&
      ['/popup.html', '/sidepanel.html', '/options.html'].includes(url.pathname)
    );
  } catch {
    return false;
  }
}
async function send(
  session: ScanSession,
  method: string,
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  try {
    const response: unknown = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(new ScanFault('PAGE_CHANGED', '页面响应超时，请稍后重新扫描')),
        3500,
      );
      chrome.tabs
        .sendMessage(
          session.tab_id,
          {
            protocol_version: '1',
            request_id: crypto.randomUUID(),
            task_id: session.task_id,
            method,
            ...extra,
          },
          { frameId: 0 },
        )
        .then(
          (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        );
    });
    if (
      !response ||
      typeof response !== 'object' ||
      !('data' in response) ||
      !('error' in response)
    )
      throw new ScanFault('INVALID_REQUEST', '扫描响应格式不正确');
    const envelope = response as {
      data: unknown;
      error: { code?: ErrorCode; message?: string } | null;
    };
    if (envelope.error)
      throw new ScanFault(
        envelope.error.code ?? 'PAGE_CHANGED',
        '页面已变化或扫描会话失效，请重新扫描',
      );
    return envelope.data;
  } catch (error) {
    if (error instanceof ScanFault) throw error;
    throw new ScanFault(
      'PAGE_CHANGED',
      '页面已跳转或权限失效，请在目标页面点击扩展后重新扫描',
    );
  }
}
async function stopSession(session: ScanSession) {
  await stopExecutionForScan(session.task_id, session.tab_id);
  try {
    await send(session, 'scan.stop');
  } catch {
    /* 页面已关闭时清理本地授权即可 */
  }
  await chrome.storage.session.remove(key);
}
async function perform(message: ScanUiMessage) {
  let session = await savedSession();
  if (message.method === 'scan.start') {
    const tab = await chrome.tabs.get(message.tab_id).catch(() => null);
    if (!tab) throw new ScanFault('UNSUPPORTED_PAGE', '目标标签页不可用');
    if (tab.url && !/^https?:\/\//.test(tab.url))
      throw new ScanFault(
        'UNSUPPORTED_PAGE',
        '浏览器内部页、扩展页和本地文件不支持扫描',
      );
    if (session) await stopSession(session);
    session = {
      task_id: crypto.randomUUID(),
      tab_id: message.tab_id,
      started_at: Date.now(),
      expires_at: Date.now() + 15 * 60 * 1000,
    };
    try {
      await chrome.scripting.executeScript({
        target: { tabId: session.tab_id, frameIds: [0] },
        files: ['content.js'],
        world: 'ISOLATED',
      });
    } catch {
      throw new ScanFault(
        'PERMISSION_DENIED',
        '尚无此页面权限，请先在目标页面点击 FormPilot 扩展图标，再启动扫描',
      );
    }
    await chrome.storage.session.set({ [key]: session });
    try {
      const data = await send(session, 'scan.initialize', { session });
      if (!Value.Check(ScanDataSchema, data))
        throw new ScanFault('INVALID_REQUEST', '扫描结果未通过校验');
      return data;
    } catch (error) {
      await stopSession(session);
      throw error;
    }
  }
  if (message.method === 'scan.get') {
    if (!session)
      return {
        session: null,
        snapshot: null,
        status: 'idle',
      } satisfies ScanData;
    if (session.expires_at < Date.now()) {
      await stopSession(session);
      return {
        session: null,
        snapshot: null,
        status: 'idle',
      } satisfies ScanData;
    }
    try {
      const data = await send(session, 'scan.read');
      if (!Value.Check(ScanDataSchema, data))
        throw new ScanFault('INVALID_REQUEST', '扫描结果无效');
      return data;
    } catch {
      return {
        session,
        snapshot: null,
        status: 'unavailable',
      } satisfies ScanData;
    }
  }
  if (!session || session.expires_at < Date.now())
    throw new ScanFault('SNAPSHOT_EXPIRED', '扫描会话已过期，请重新扫描');
  if (message.task_id !== session.task_id)
    throw new ScanFault('SCOPE_DENIED', '扫描会话不匹配');
  if ('tab_id' in message && message.tab_id !== session.tab_id)
    throw new ScanFault('SCOPE_DENIED', '目标标签页不匹配');
  if (
    'ref' in message &&
    (message.ref.tab_id !== session.tab_id ||
      message.ref.task_id !== session.task_id ||
      message.ref.frame_id !== 0)
  )
    throw new ScanFault('SCOPE_DENIED', '快照不属于当前扫描页面');
  if (message.method === 'scan.stop') {
    await stopSession(session);
    return { session: null, snapshot: null, status: 'idle' } satisfies ScanData;
  }
  const extra =
    'ref' in message
      ? {
          ref: message.ref,
          field_id: message.field_id,
          ...('label' in message ? { label: message.label } : {}),
        }
      : {};
  const data = await send(session, message.method, extra);
  if (
    !Value.Check(
      message.method === 'scan.locate' ? LocateResultSchema : ScanDataSchema,
      data,
    )
  )
    throw new ScanFault('INVALID_REQUEST', '扫描响应未通过协议校验');
  return data;
}
// 所有授权/停止操作串行化，避免并发启动使不同标签页串用同一会话。
let queue: Promise<unknown> = Promise.resolve();
export function handleScannerMessage(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (response: unknown) => void,
): boolean | undefined {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('method' in raw) ||
    typeof raw.method !== 'string' ||
    !raw.method.startsWith('scan.')
  )
    return undefined;
  if (!trustedSender(sender)) {
    respond(failure('invalid', 'SCOPE_DENIED', '此来源不能操作扫描器'));
    return false;
  }
  if (
    new URL(sender.url!).pathname === '/options.html' &&
    !['scan.get', 'scan.locate'].includes(raw.method)
  ) {
    respond(failure('invalid', 'SCOPE_DENIED', '资料库仅可读取和定位扫描结果'));
    return false;
  }
  if (!isScanUiMessage(raw)) {
    respond(failure('invalid', 'INVALID_REQUEST', '扫描消息格式无效'));
    return false;
  }
  const work = queue.then(() => perform(raw));
  queue = work.catch(() => undefined);
  void work
    .then((data) => respond({ request_id: raw.request_id, data, error: null }))
    .catch((error) =>
      respond(
        failure(
          raw.request_id,
          error instanceof ScanFault ? error.code : 'PAGE_CHANGED',
          error instanceof ScanFault
            ? error.userMessage
            : '页面已变化，请重新扫描',
        ),
      ),
    );
  return true;
}
function eventWork(work: () => Promise<unknown>) {
  const result = queue.then(work);
  queue = result.catch(() => undefined);
}
chrome.tabs.onRemoved.addListener((tabId) => {
  eventWork(async () => {
    const session = await savedSession();
    if (session?.tab_id === tabId) {
      await stopExecutionForScan(session.task_id, tabId);
      await chrome.storage.session.remove(key);
    }
  });
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading')
    eventWork(async () => {
      const session = await savedSession();
      if (session?.tab_id === tabId) await stopSession(session);
    });
});
