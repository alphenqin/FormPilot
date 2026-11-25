import { it, expect } from 'vitest';
import {
  isExecutionUiMessage,
  sameExecutionScope,
  type ScanRef,
} from './index';
it('执行 UI 消息仅接受固定方法和引用，不接收任意值、脚本、选择器或 URL', () => {
  const base = {
    protocol_version: '1',
    request_id: 'request-1',
    task_id: 'task-1',
    method: 'execution.start',
    workspace_id: 'workspace-1',
    execution_id: 'execution-1',
  };
  expect(isExecutionUiMessage(base)).toBe(true);
  for (const extra of [
    { value: 'fabricated' },
    { script: 'submit()' },
    { selector: '#password' },
    { url: 'https://example.test' },
    { frame_id: 1 },
    { method: 'execution.submit' },
  ])
    expect(isExecutionUiMessage({ ...base, ...extra })).toBe(false);
});
it('自身写入只改变快照 ID；任务、tab、页面身份和结构指纹仍严格绑定', () => {
  const ref: ScanRef = {
    task_id: 'task-1',
    tab_id: 1,
    frame_id: 0,
    page_instance_id: 'page-1',
    form_snapshot_id: 'snapshot-1',
    dom_fingerprint: 'a'.repeat(64),
  };
  expect(
    sameExecutionScope(ref, { ...ref, form_snapshot_id: 'snapshot-2' }),
  ).toBe(true);
  for (const change of [
    { task_id: 'other' },
    { tab_id: 2 },
    { page_instance_id: 'other' },
    { dom_fingerprint: 'b'.repeat(64) },
  ])
    expect(sameExecutionScope(ref, { ...ref, ...change })).toBe(false);
});
