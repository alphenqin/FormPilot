import { handleCareerCapture } from './career';
import { handleExecutionMessage } from './execution';
import { handleScannerMessage } from './scanner';
import { requestHealth } from './health';
import { WEB_ORIGIN, failure, isMessage } from '@formpilot/contracts';
const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
interface Session {
  token: string;
  origin: string;
  tab_id: number;
  expires: number;
}
// 串行处理配对，避免一个一次性配对码被并发兑换。
let pairingQueue = Promise.resolve();
async function external(
  message: unknown,
  sender: chrome.runtime.MessageSender,
) {
  const request_id = isMessage(message) ? message.request_id : 'invalid';
  if (!isMessage(message))
    return failure(request_id, 'INVALID_REQUEST', '消息格式无效');
  let origin = '';
  try {
    origin = new URL(sender.url ?? '').origin;
  } catch {
    /* 拒绝缺少 URL 的 sender */
  }
  if (
    sender.origin !== WEB_ORIGIN ||
    origin !== WEB_ORIGIN ||
    sender.frameId !== 0 ||
    sender.tab?.id === undefined
  )
    return failure(request_id, 'SCOPE_DENIED', '来源不在允许范围');
  if (message.method === 'pair') {
    const stored = await chrome.storage.session.get('pairing');
    const pairing = stored.pairing as
      | { code?: unknown; expires?: unknown }
      | undefined;
    if (
      !pairing ||
      pairing.code !== message.pairing_code ||
      typeof pairing.expires !== 'number' ||
      pairing.expires < Date.now()
    )
      return failure(
        request_id,
        'CONSENT_REQUIRED',
        '请在扩展中生成有效的一次性配对码',
      );
    const session: Session = {
      token: hex(32),
      origin,
      tab_id: sender.tab.id,
      expires: Date.now() + 30 * 60 * 1000,
    };
    await chrome.storage.session.remove('pairing');
    await chrome.storage.session.set({ ['session_' + sender.tab.id]: session });
    return {
      request_id,
      data: { session_token: session.token, expires_at: session.expires },
      error: null,
    };
  }
  if (message.method !== 'ping')
    return failure(request_id, 'SCOPE_DENIED', '网页通道只开放 pair/ping');
  const key = 'session_' + sender.tab.id;
  const session = (await chrome.storage.session.get(key))[key] as
    | Session
    | undefined;
  if (
    !session ||
    session.token !== message.session_token ||
    session.origin !== origin ||
    session.expires < Date.now()
  )
    return failure(request_id, 'UNAUTHORIZED', '配对会话不存在或已过期');
  let api_connected = false;
  try {
    await requestHealth();
    api_connected = true;
  } catch {
    /* 与扩展连接状态分别报告 */
  }
  return {
    request_id,
    data: { pong: true, protocol_version: '1', api_connected },
    error: null,
  };
}
chrome.runtime.onMessageExternal.addListener(
  (message: unknown, sender, respond) => {
    pairingQueue = pairingQueue.then(async () => {
      try {
        respond(await external(message, sender));
      } catch {
        respond(failure('invalid', 'INTERNAL_ERROR', '配对服务暂不可用'));
      }
    });
    return true;
  },
);
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  const career = handleCareerCapture(message, sender, respond);
  if (career !== undefined) return career;
  const execution = handleExecutionMessage(message, sender, respond);
  if (execution !== undefined) return execution;
  const scan = handleScannerMessage(message, sender, respond);
  if (scan !== undefined) return scan;
  const expected = chrome.runtime.getURL('');
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(expected) ||
    !['popup.html', 'options.html', 'sidepanel.html'].includes(
      new URL(sender.url).pathname.slice(1),
    )
  ) {
    respond(failure('invalid', 'SCOPE_DENIED', '来源不允许'));
    return false;
  }
  if (!isMessage(message) || message.method !== 'health') {
    respond(failure('invalid', 'INVALID_REQUEST', '消息格式无效'));
    return false;
  }
  void requestHealth()
    .then(respond)
    .catch(() =>
      respond(
        failure(
          message.request_id,
          'SERVICE_UNAVAILABLE',
          '无法连接 API，请检查本地服务',
          true,
        ),
      ),
    );
  return true;
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove('session_' + tabId);
});
