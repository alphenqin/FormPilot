import { Value } from '@sinclair/typebox/value';
import {
  JobCaptureMessageSchema,
  JobCaptureResultSchema,
  failure,
  type ErrorCode,
} from '@formpilot/contracts';
import { sanitizeJobURL } from '@formpilot/domain';
export function handleCareerCapture(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (data: unknown) => void,
): boolean | undefined {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('method' in raw) ||
    typeof raw.method !== 'string' ||
    !raw.method.startsWith('career.')
  )
    return undefined;
  const id =
    'request_id' in raw && typeof raw.request_id === 'string'
      ? raw.request_id
      : 'invalid';
  if (
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL('options.html')
  ) {
    respond(failure(id, 'SCOPE_DENIED', '只有资料库可读取岗位正文'));
    return false;
  }
  if (!Value.Check(JobCaptureMessageSchema, raw)) {
    respond(failure(id, 'INVALID_REQUEST', '岗位读取请求无效'));
    return false;
  }
  void (async () => {
    const tab = await chrome.tabs.get(raw.tab_id);
    if (tab.url && !/^https?:\/\//.test(tab.url))
      throw new Error('UNSUPPORTED_PAGE');
    let frames;
    try {
      frames = await chrome.scripting.executeScript({
        target: { tabId: raw.tab_id, frameIds: [0] },
        world: 'ISOLATED',
        func: () => {
          const initial = location.href,
            root =
              document.querySelector('main,[role="main"],article') ??
              document.body;
          const excluded =
            'script,style,noscript,template,nav,header,footer,form,input,textarea,select,button,[contenteditable="true"],[role="dialog"],[data-private],[hidden],[inert],[aria-hidden="true"]';
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
            parts: string[] = [];
          let node: Node | null,
            last: Element | null = null,
            total = 0,
            truncated = false;
          while ((node = walker.nextNode())) {
            const parent = node.parentElement;
            if (
              !parent ||
              parent.closest(excluded) ||
              !parent.getClientRects().length
            )
              continue;
            const style = getComputedStyle(parent);
            if (style.visibility !== 'visible' || style.opacity === '0')
              continue;
            const value = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
            if (!value) continue;
            const block = parent.closest(
              'p,li,div,section,h1,h2,h3,h4,article,main',
            );
            if (parts.length) parts.push(block === last ? ' ' : '\n');
            parts.push(value);
            last = block;
            total += value.length + 1;
            if (total > 21000) {
              truncated = true;
              break;
            }
          }
          const text = parts.join('').trim();
          if (location.href !== initial) throw new Error('PAGE_CHANGED');
          if (
            !/岗位|任职|职位|职责|招聘|requirements?|responsibilit|qualifications?|job description/i.test(
              text,
            )
          )
            throw new Error('UNSUPPORTED_PAGE');
          return {
            text: text.slice(0, 20000),
            title: (root.querySelector('h1')?.textContent ?? document.title)
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 200),
            url: initial,
            truncated: truncated || text.length > 20000,
            fallback: root === document.body,
          };
        },
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /UNSUPPORTED_PAGE|PAGE_CHANGED/.test(error.message)
      )
        throw error;
      throw new Error('PERMISSION_DENIED');
    }
    const data = frames.find((frame) => frame.frameId === 0)?.result;
    if (!data || !data.text.trim()) throw new Error('UNSUPPORTED_PAGE');
    const result = {
      source: {
        source_id: crypto.randomUUID(),
        text: data.text,
        title_hint: data.title,
        page_url: sanitizeJobURL(data.url),
        captured_at: Date.now(),
        method: 'page',
        truncated: data.truncated,
      },
      warning_codes: [
        ...(data.truncated ? ['TEXT_TRUNCATED'] : []),
        ...(data.fallback ? ['BODY_FALLBACK_REVIEW'] : []),
      ],
    };
    if (!Value.Check(JobCaptureResultSchema, result))
      throw new Error('INVALID_REQUEST');
    return result;
  })()
    .then((data) => respond({ request_id: id, data, error: null }))
    .catch((error) => {
      const code: ErrorCode =
        error instanceof Error && error.message === 'UNSUPPORTED_PAGE'
          ? 'UNSUPPORTED_PAGE'
          : error instanceof Error && error.message === 'PAGE_CHANGED'
            ? 'PAGE_CHANGED'
            : 'PERMISSION_DENIED';
      respond(
        failure(
          id,
          code,
          '请在岗位详情页点击扩展图标获得当前页权限；无法识别的页面可粘贴 JD 原文',
        ),
      );
    });
  return true;
}
