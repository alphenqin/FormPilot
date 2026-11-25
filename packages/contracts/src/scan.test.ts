import { it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  isScanUiMessage,
  isScanContentMessage,
  ScanRefSchema,
  isMessage,
  FormSnapshotSchema,
} from './index';
const base = {
  protocol_version: '1',
  request_id: 'req-1',
  task_id: null,
  method: 'scan.start',
  tab_id: 10,
};
it('扫描消息受协议、作用域和属性白名单约束', () => {
  expect(isScanUiMessage(base)).toBe(true);
  for (const value of [
    { ...base, protocol_version: '2' },
    { ...base, tab_id: -1 },
    { ...base, frame_id: 1 },
    { ...base, script: 'steal()' },
    { ...base, method: 'scan.execute' },
    { ...base, task_id: 'forged' },
  ])
    expect(isScanUiMessage(value)).toBe(false);
});
it('网页配对通道不接受扫描或任意执行消息', () => {
  expect(isMessage(base)).toBe(false);
  expect(isMessage({ ...base, method: 'scan.locate' })).toBe(false);
});
it('定位要求页面、快照、任务与 fingerprint，iframe 作用域拒绝', () => {
  const ref = {
    task_id: 'task',
    tab_id: 1,
    frame_id: 0,
    page_instance_id: 'page',
    form_snapshot_id: 'snapshot',
    dom_fingerprint: 'a'.repeat(64),
  };
  expect(Value.Check(ScanRefSchema, ref)).toBe(true);
  for (const update of [
    { frame_id: 1 },
    { dom_fingerprint: 'wrong' },
    { page_instance_id: '' },
  ])
    expect(Value.Check(ScanRefSchema, { ...ref, ...update })).toBe(false);
  expect(
    isScanUiMessage({
      protocol_version: '1',
      request_id: 'req',
      task_id: 'task',
      method: 'scan.locate',
      ref,
      field_id: 'field',
    }),
  ).toBe(true);
});
it('内容脚本不接受网页侧 UI 的启动命令，拒绝坏结果和文件路径值', () => {
  expect(isScanContentMessage(base)).toBe(false);
  expect(
    Value.Check(FormSnapshotSchema, {
      fields: [{ current_value: { file: 'private.pdf' } }],
    }),
  ).toBe(false);
});
