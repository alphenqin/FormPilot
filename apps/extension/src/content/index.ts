import {
  FormScanner,
  FormExecutor,
  ScannerFault,
} from '@formpilot/browser-engine';
import {
  isScanContentMessage,
  isExecutionContentMessage,
  failure,
  type ScanSession,
} from '@formpilot/contracts';
// 此全局仅存在于扩展隔离 world；网页脚本不能读取或调用它。
const state = globalThis as typeof globalThis & {
  __formpilotScanRuntime?: { stop: () => void };
};
if (!state.__formpilotScanRuntime) {
  let scanner: FormScanner | null = null;
  let executor: FormExecutor | null = null;
  let workspace: string | null = null;
  let session: ScanSession | null = null;
  const stop = () => {
    executor?.stop();
    executor = null;
    workspace = null;
    scanner?.stop();
    scanner = null;
    session = null;
  };
  state.__formpilotScanRuntime = { stop };
  chrome.runtime.onMessage.addListener((raw: unknown, sender, respond) => {
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab ||
      !sender.url?.startsWith(chrome.runtime.getURL(''))
    ) {
      respond(failure('invalid', 'SCOPE_DENIED', '扫描消息来源无效'));
      return false;
    }
    if (isExecutionContentMessage(raw)) {
      if (sender.url !== chrome.runtime.getURL('background.js')) {
        respond(
          failure(raw.request_id, 'SCOPE_DENIED', '执行命令必须来自 worker'),
        );
        return false;
      }
      const message = raw;
      void (async () => {
        if (
          !scanner ||
          !session ||
          session.task_id !== message.task_id ||
          !executor
        )
          throw new ScannerFault('SNAPSHOT_EXPIRED');
        if (message.method === 'execution.run') {
          workspace = message.workspace_id;
          return executor.start(message.packet, message.started_at);
        }
        if (message.method === 'execution.stop')
          return executor.cancel(message.execution_id);
        return executor.state(message.execution_id);
      })()
        .then((data) =>
          respond({ request_id: message.request_id, data, error: null }),
        )
        .catch((error) =>
          respond(
            failure(
              message.request_id,
              error instanceof ScannerFault
                ? error.code
                : 'EXECUTION_INTERRUPTED',
              '执行已阻止或状态不可用',
            ),
          ),
        );
      return true;
    }
    if (!isScanContentMessage(raw)) {
      respond(failure('invalid', 'INVALID_REQUEST', '扫描消息格式无效'));
      return false;
    }
    const message = raw;
    void (async () => {
      if (message.method === 'scan.initialize') {
        if (
          message.task_id !== message.session.task_id ||
          message.session.expires_at <= Date.now()
        )
          throw new ScannerFault('SCOPE_DENIED');
        stop();
        session = message.session;
        scanner = new FormScanner(session);
        executor = new FormExecutor(scanner, async (checkpoint) => {
          if (!workspace) throw new ScannerFault('UNAUTHORIZED');
          const response = await chrome.runtime.sendMessage({
            protocol_version: '1',
            request_id: crypto.randomUUID(),
            task_id: checkpoint.task_id,
            method: 'execution.checkpoint',
            workspace_id: workspace,
            checkpoint,
          });
          if (response.error) throw new ScannerFault(response.error.code);
          return response.data;
        });
        const snapshot = await scanner.scan(true);
        scanner.watch(() => {
          /* 结果仅在当前页面内存中；UI 通过短消息查询。 */
        });
        return { session, snapshot, status: 'active' };
      }
      if (!scanner || !session || session.task_id !== message.task_id)
        throw new ScannerFault('SNAPSHOT_EXPIRED');
      if (message.method === 'scan.stop') {
        stop();
        return { session: null, snapshot: null, status: 'idle' };
      }
      if (message.method === 'scan.locate')
        return scanner.locate(message.ref, message.field_id, true);
      const snapshot =
        message.method === 'scan.annotate'
          ? await scanner.annotate(message.ref, message.field_id, message.label)
          : await scanner.scan(message.method === 'scan.refresh');
      return { session, snapshot, status: 'active' };
    })()
      .then((data) =>
        respond({ request_id: message.request_id, data, error: null }),
      )
      .catch((error) =>
        respond(
          failure(
            message.request_id,
            error instanceof ScannerFault ? error.code : 'PAGE_CHANGED',
            '页面已变化、权限失效或扫描结果不可用，请重新扫描',
          ),
        ),
      );
    return true;
  });
  window.addEventListener('pagehide', stop);
}
