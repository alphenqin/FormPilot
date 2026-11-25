import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import {
  initializeExecution,
  packetFor,
  runPacket,
  finished,
  undoPacket,
} from './execution-browser';
test('原生 input/textarea/date/month/select/multiple/radio/checkbox 写入、回读和撤销，不触碰敏感或提交控件', async ({
  page,
}) => {
  await initializeExecution(page);
  const packet = await packetFor(page, {
    name: '原生合成同学',
    email: 'native@example.test',
    phone: '13800000001',
    intention: 'HZ',
    date: '2024-05-06',
    month: '2024-06',
    description: '第一行\n第二行',
    ['multiple']: ['a', 'b'],
    contact: true,
    availability: 'soon',
  });
  await runPacket(page, packet);
  const report = await finished(page, packet.execution_id);
  expect(report.report.field_results).toHaveLength(10);
  expect(
    report.report.field_results.every((f) => f.status === 'verified'),
  ).toBe(true);
  expect(
    await page
      .locator('#multiple')
      .evaluate((e: HTMLSelectElement) =>
        [...e.selectedOptions].map((o) => o.value),
      ),
  ).toEqual(['a', 'b']);
  expect(await page.locator('#consent').isChecked()).toBe(false);
  expect(await page.locator('#password').inputValue()).toBe(
    'M4_PASSWORD_SENTINEL',
  );
  expect(await page.evaluate(() => window.submits)).toBe(0);
  const undo = await undoPacket(page, packet);
  await runPacket(page, undo);
  const restored = await finished(page, undo.execution_id);
  expect(
    restored.report.field_results.every((f) => f.status === 'verified'),
  ).toBe(true);
  expect(await page.locator('#name').inputValue()).toBe('网页原姓名');
  expect(await page.locator('#intention').inputValue()).toBe('');
  expect(await page.locator('#contact').isChecked()).toBe(false);
  expect(await page.evaluate(() => window.submits)).toBe(0);
});
test('写后异步清空返回 VALUE_NOT_PERSISTED，明确重试才再次写入', async ({
  page,
}) => {
  await initializeExecution(page, 'reset');
  const p = await packetFor(page, { email: 'reset@example.test' });
  await runPacket(page, p);
  const failed = await finished(page, p.execution_id);
  expect(failed.report.field_results[0]).toMatchObject({
    status: 'failed',
    actual: '',
    error_code: 'VALUE_NOT_PERSISTED',
  });
  await page.evaluate(() => {
    window.scenario = '';
  });
  const retry = await packetFor(
    page,
    { email: 'reset@example.test' },
    { action: 'retry', source_execution_id: p.execution_id, epoch: 2 },
  );
  await runPacket(page, retry);
  expect(
    (await finished(page, retry.execution_id)).report.field_results[0]?.status,
  ).toBe('verified');
});
test('站点 validity/aria-invalid 失败时不报告 verified', async ({ page }) => {
  await initializeExecution(page, 'invalid');
  const p = await packetFor(page, { email: 'invalid@example.test' });
  await runPacket(page, p);
  expect(
    (await finished(page, p.execution_id)).report.field_results[0]?.error_code,
  ).toBe('SITE_VALIDATION_FAILED');
});
test('结构变动停止整个旧计划，后续字段不写入', async ({ page }) => {
  await initializeExecution(page, 'structure');
  const p = await packetFor(page, {
    name: '结构测试',
    email: 'untouched@example.test',
  });
  await runPacket(page, p);
  const report = await finished(page, p.execution_id);
  expect(report.last_error).toBe('PAGE_CHANGED');
  expect(report.report.field_results.every((f) => f.status === 'failed')).toBe(
    true,
  );
  expect(await page.locator('#email').inputValue()).toBe('');
});
test('最终再次回读捕获早先字段在后续字段处理期间被清空', async ({ page }) => {
  await initializeExecution(page, 'final-reset');
  const p = await packetFor(page, {
    name: '最终回读',
    email: 'final@example.test',
  });
  await runPacket(page, p);
  const report = await finished(page, p.execution_id);
  expect(report.report.field_results[0]).toMatchObject({
    status: 'failed',
    actual: '',
    error_code: 'VALUE_NOT_PERSISTED',
  });
  expect(report.report.field_results[1]?.status).toBe('verified');
});
test('后续字段被用户改动时保留新值，独立字段继续', async ({ page }) => {
  await initializeExecution(page);
  const p = await packetFor(page, {
    name: '保留用户新值',
    email: 'planned@example.test',
    phone: '13800000002',
  });
  await runPacket(page, p);
  await expect(page.locator('#name')).toHaveValue('保留用户新值');
  await page.locator('#email').fill('user@example.test');
  const result = await finished(page, p.execution_id);
  expect(result.report.field_results[1]?.error_code).toBe('USER_CHANGED');
  expect(result.report.field_results[2]?.status).toBe('verified');
  expect(await page.locator('#email').inputValue()).toBe('user@example.test');
});
test('用户改后又改回相同值，撤销仍保护该字段', async ({ page }) => {
  await initializeExecution(page);
  const p = await packetFor(page, { name: '写入目标' });
  await runPacket(page, p);
  await finished(page, p.execution_id);
  await page.locator('#name').fill('后来编辑');
  await page.locator('#name').fill('写入目标');
  const undo = await undoPacket(page, p);
  await runPacket(page, undo);
  expect(
    (await finished(page, undo.execution_id)).report.field_results[0]
      ?.error_code,
  ).toBe('USER_CHANGED');
  expect(await page.locator('#name').inputValue()).toBe('写入目标');
});
test('停止与资料库守卫失效都阻止后续写入', async ({ page }) => {
  await initializeExecution(page);
  let p = await packetFor(page, {
    name: '停止测试',
    email: 'not-written@example.test',
  });
  await runPacket(page, p);
  await expect(page.locator('#name')).toHaveValue('停止测试');
  await page.evaluate((id) => window.__m4executor.cancel(id), p.execution_id);
  await finished(page, p.execution_id);
  expect(await page.locator('#email').inputValue()).toBe('');
  await initializeExecution(page);
  p = await packetFor(page, { name: '资料库已锁定' });
  await page.evaluate(() => {
    window.__m4guard = false;
  });
  await runPacket(page, p);
  expect((await finished(page, p.execution_id)).last_error).toBe(
    'EXECUTION_INTERRUPTED',
  );
  expect(await page.locator('#name').inputValue()).toBe('网页原姓名');
});
test('旧快照、错页和未知字段拒绝启动，执行命令不能借标签定位其他控件', async ({
  page,
}) => {
  await initializeExecution(page);
  const p = await packetFor(page, { name: '计划值' });
  await page.locator('#name').fill('用户新值');
  await expect(
    page.evaluate((packet) => window.__m4executor.start(packet, Date.now()), p),
  ).rejects.toThrow('STALE_SNAPSHOT');
  expect(await page.locator('#name').inputValue()).toBe('用户新值');
  const next = await packetFor(page, { name: '计划值' });
  await expect(
    page.evaluate(
      (packet) =>
        window.__m4executor.start(
          {
            ...packet,
            snapshot_ref: { ...packet.snapshot_ref, tab_id: 999 },
            observed_snapshot_ref: {
              ...packet.observed_snapshot_ref,
              tab_id: 999,
            },
          },
          Date.now(),
        ),
      next,
    ),
  ).rejects.toThrow('SCOPE_DENIED');
  await expect(
    page.evaluate(
      (packet) =>
        window.__m4executor.start(
          {
            ...packet,
            items: packet.items.map((item) => ({
              ...item,
              field: { ...item.field, field_id: 'invented' },
            })),
          },
          Date.now(),
        ),
      next,
    ),
  ).rejects.toThrow('LOCATOR_NOT_FOUND');
});
test('重复命令只执行一次，另一次执行与过期 lease 不得覆盖', async ({
  page,
}) => {
  await initializeExecution(page);
  const p = await packetFor(page, { email: 'once@example.test' });
  await runPacket(page, p);
  await runPacket(page, p);
  const other = await packetFor(page, { name: '并发任务' }, { epoch: 2 });
  await expect(
    page.evaluate(
      (packet) => window.__m4executor.start(packet, Date.now()),
      other,
    ),
  ).rejects.toThrow('EXECUTION_LOCKED');
  await finished(page, p.execution_id);
  expect(await page.evaluate(() => window.writeEvents)).toBe(2);
  const expired = await packetFor(page, { name: '过期任务' }, { epoch: 2 });
  expired.expires_at = 0;
  await runPacket(page, expired);
  expect((await finished(page, expired.execution_id)).last_error).toBe(
    'EXECUTION_EXPIRED',
  );
  expect(await page.locator('#name').inputValue()).toBe('网页原姓名');
});
test('页面重载后不能使用旧计划，也不能自动重放撤销', async ({ page }) => {
  await initializeExecution(page);
  const p = await packetFor(page, { name: '重载测试' });
  await runPacket(page, p);
  await finished(page, p.execution_id);
  const undo = await undoPacket(page, p);
  await initializeExecution(page);
  await expect(
    page.evaluate(
      (packet) => window.__m4executor.start(packet, Date.now()),
      undo,
    ),
  ).rejects.toThrow('SCOPE_DENIED');
  expect(await page.locator('#name').inputValue()).toBe('网页原姓名');
});
test('真实 React 受控输入：原型 setter 触发 onChange，异步 setState 清空被回读捕获', async ({
  page,
}) => {
  await initializeExecution(page);
  await page.evaluate(
    async (path) => {
      const preamble = '/@react-refresh';
      const { injectIntoGlobalHook } = await import(preamble);
      injectIntoGlobalHook(window);
      Object.assign(window, {
        $RefreshReg$: () => {},
        $RefreshSig$: () => (type: unknown) => type,
      });
      const { mountReactForm } = await import(path);
      mountReactForm('reset');
    },
    '/@fs' + resolve('tests/fixtures/react-execution.tsx'),
  );
  await expect(page.locator('#react-email')).toBeVisible();
  const first = await packetFor(page, { 'react-email': 'react@example.test' });
  await runPacket(page, first);
  expect(
    (await finished(page, first.execution_id)).report.field_results[0]
      ?.error_code,
  ).toBe('VALUE_NOT_PERSISTED');
  await page.evaluate(
    async (path) => {
      const { mountReactForm } = await import(path);
      mountReactForm('accept');
    },
    '/@fs' + resolve('tests/fixtures/react-execution.tsx'),
  );
  const retry = await packetFor(
    page,
    { 'react-email': 'react@example.test' },
    { action: 'retry', source_execution_id: first.execution_id, epoch: 2 },
  );
  await runPacket(page, retry);
  expect(
    (await finished(page, retry.execution_id)).report.field_results[0]?.status,
  ).toBe('verified');
  expect(await page.locator('#react-email').inputValue()).toBe(
    'react@example.test',
  );
  expect(await page.evaluate(() => window.submits)).toBe(0);
});
test('异步预检期间收到并发重复启动也只写一次', async ({ page }) => {
  await initializeExecution(page);
  const packet = await packetFor(page, { email: 'raced@example.test' });
  await page.evaluate(async (p) => {
    const start = window.__m4views[p.execution_id]!.report.started_at;
    await Promise.all([
      window.__m4executor.start(p, start),
      window.__m4executor.start(p, start),
    ]);
  }, packet);
  expect(
    (await finished(page, packet.execution_id)).report.field_results[0]?.status,
  ).toBe('verified');
  expect(await page.evaluate(() => window.writeEvents)).toBe(2);
});
test('条款和附件即使进入伪造内部 packet 也不执行', async ({ page }) => {
  await initializeExecution(page);
  const consent = await packetFor(page, { consent: true });
  await expect(
    page.evaluate((p) => window.__m4executor.start(p, Date.now()), consent),
  ).rejects.toThrow('CONTROL_UNSUPPORTED');
  expect(await page.locator('#consent').isChecked()).toBe(false);
  const file = await packetFor(page, { file: 'not-a-file' });
  await expect(
    page.evaluate((p) => window.__m4executor.start(p, Date.now()), file),
  ).rejects.toThrow('CONTROL_UNSUPPORTED');
  expect(await page.locator('#file').inputValue()).toBe('');
  expect(await page.evaluate(() => window.submits)).toBe(0);
});
test('等待写前检查点期间用户编辑后又改回，撤销仍不覆盖', async ({ page }) => {
  await initializeExecution(page);
  const p = await packetFor(page, { name: '并发编辑保护' });
  await runPacket(page, p);
  await finished(page, p.execution_id);
  const undo = await undoPacket(page, p);
  await page.evaluate(() => {
    window.__m4beforeDelay = 600;
  });
  await runPacket(page, undo);
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.__m4journal.some(
            (j) => j.execution_id === id && j.phase === 'before',
          ),
        undo.execution_id,
      ),
    )
    .toBe(true);
  await page.locator('#name').fill('检查点期间编辑');
  await page.locator('#name').fill('并发编辑保护');
  const state = await finished(page, undo.execution_id);
  expect(state.report.field_results[0]?.error_code).toBe('USER_CHANGED');
  expect(await page.locator('#name').inputValue()).toBe('并发编辑保护');
});
test('执行中修改人工语义标注会停止旧计划，不能当作自身填值忽略', async ({
  page,
}) => {
  await initializeExecution(page);
  const packet = await packetFor(page, {
    name: '标注变化测试',
    email: 'not-written@example.test',
  });
  await runPacket(page, packet);
  await expect(page.locator('#name')).toHaveValue('标注变化测试');
  await page.evaluate(async () => {
    const snapshot = await window.__m4scanner.scan(),
      field = snapshot.fields.find((f) => f.html_id === 'description')!;
    await window.__m4scanner.annotate(
      snapshot,
      field.field_id,
      '人工标注已变化',
    );
  });
  const report = await finished(page, packet.execution_id);
  expect(report.last_error).toBe('PAGE_CHANGED');
  expect(await page.locator('#email').inputValue()).toBe('');
});
