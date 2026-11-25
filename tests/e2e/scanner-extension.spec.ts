import { test, expect, type Page, type Worker } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { openExtension } from './extension';
import { snapshotRef, type ScanData } from '@formpilot/contracts';
async function tabId(worker: Worker, url: string) {
  return worker.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url);
    if (tab?.id === undefined) throw new Error('fixture tab not found');
    return tab.id;
  }, url);
}
async function message(
  page: Page,
  method: string,
  args: Record<string, unknown> = {},
  task_id: string | null = null,
) {
  return page.evaluate(
    async ({ method, args, task_id }) =>
      chrome.runtime.sendMessage({
        protocol_version: '1',
        request_id: crypto.randomUUID(),
        task_id,
        method,
        ...args,
      }),
    { method, args, task_id },
  );
}
async function data(page: Page): Promise<ScanData> {
  const reply = await message(page, 'scan.get');
  expect(reply.error).toBeNull();
  return reply.data as ScanData;
}
async function setup(name: string) {
  const extension = await openExtension();
  const fixture = await extension.context.newPage();
  const url = 'http://127.0.0.1:3000/m2-fixtures/' + name;
  await fixture.goto(url);
  const worker = extension.context.serviceWorkers()[0]!;
  const id = await tabId(worker, url);
  const panel = await extension.context.newPage();
  await panel.goto(`chrome-extension://${extension.id}/sidepanel.html`);
  await panel.getByLabel('要扫描的标签页').selectOption(String(id));
  return { ...extension, panel, fixture, worker, targetId: id };
}
test('实际扩展按需注入、预览和定位，不写网页，不持久化字段值', async () => {
  const e = await setup('basic.html');
  try {
    const posts: string[] = [];
    e.context.on('request', (request) => {
      if (request.method() === 'POST') posts.push(request.url());
    });
    await e.panel
      .getByRole('button', { name: '开始扫描', exact: true })
      .click();
    await expect(e.panel.getByTestId('scan-summary')).toContainText(
      '12 个字段',
    );
    const scanned = await data(e.panel);
    expect(scanned.snapshot?.fields).toHaveLength(12);
    const card = e.panel
      .locator('.scan-field')
      .filter({ hasText: '合成测试同学' });
    await card.getByRole('button', { name: '定位到网页' }).click();
    await expect(e.panel.getByTestId('scan-status')).toContainText(
      '未修改字段内容',
    );
    await card
      .locator('summary')
      .filter({ hasText: '人工标注字段含义' })
      .click();
    await card.getByLabel('字段标注').fill('申请人姓名');
    await card.getByRole('button', { name: '保存标注' }).click();
    await expect(card).toContainText('申请人姓名');
    expect(await e.fixture.locator('#full-name').inputValue()).toBe(
      '合成测试同学',
    );
    expect(
      await e.fixture.evaluate(() => [window.writeEvents, window.submits]),
    ).toEqual([0, 0]);
    const stored = await e.worker.evaluate(async () =>
      JSON.stringify(await chrome.storage.session.get(null)),
    );
    expect(stored).not.toContain('合成测试同学');
    expect(stored).not.toContain('13800000000');
    expect(posts).toEqual([]);
    await e.panel.screenshot({
      path: 'test-results/m2-scan-preview.png',
      fullPage: true,
    });
    await e.panel.getByRole('button', { name: '停止扫描' }).click();
    await expect(e.panel.getByTestId('scan-status')).toContainText(
      '快照已清除',
    );
    expect((await data(e.panel)).snapshot).toBeNull();
  } finally {
    await e.context.close();
    await rm(e.dir, { recursive: true, force: true });
  }
});
test('实际扩展动态增删重扫、无事件值变化、旧快照及异步路由守卫', async () => {
  const e = await setup('dynamic.html');
  try {
    await e.panel
      .getByRole('button', { name: '开始扫描', exact: true })
      .click();
    await expect(e.panel.getByTestId('scan-summary')).toContainText('8 个字段');
    const first = (await data(e.panel)).snapshot!;
    const field = first.fields.find((f) => f.name === 'company')!;
    await e.fixture.locator('#add-experience').click();
    await expect(e.panel.getByTestId('scan-summary')).toContainText('9 个字段');
    const next = (await data(e.panel)).snapshot!;
    expect(next.dom_fingerprint).not.toBe(first.dom_fingerprint);
    const old = await message(
      e.panel,
      'scan.locate',
      { ref: snapshotRef(first), field_id: field.field_id },
      first.task_id,
    );
    expect(old.error.code).toBe('STALE_SNAPSHOT');
    await e.fixture
      .locator('#company-one')
      .evaluate((input: HTMLInputElement) => {
        input.value = '无事件的新值';
      });
    await expect(
      e.panel.locator('.scan-field').filter({ hasText: '无事件的新值' }),
    ).toBeVisible();
    const value = (await data(e.panel)).snapshot!;
    expect(value.dom_fingerprint).toBe(next.dom_fingerprint);
    await e.fixture.locator('#route-change').click();
    await expect
      .poll(async () => {
        const s = (await data(e.panel)).snapshot;
        return s === null || s.page_instance_id !== value.page_instance_id;
      })
      .toBe(true);
    const stale = await message(
      e.panel,
      'scan.locate',
      { ref: snapshotRef(value), field_id: field.field_id },
      value.task_id,
    );
    expect(stale.error).not.toBeNull();
  } finally {
    await e.context.close();
    await rm(e.dir, { recursive: true, force: true });
  }
});
test('网页不能发起扫描，跨 tab/frame/任务/未知字段与未授权页面被拒绝', async () => {
  const e = await setup('basic.html');
  try {
    await e.panel
      .getByRole('button', { name: '开始扫描', exact: true })
      .click();
    await expect(e.panel.getByTestId('scan-summary')).toContainText(
      '12 个字段',
    );
    const s = (await data(e.panel)).snapshot!;
    const f = s.fields[0]!;
    for (const ref of [
      { ...snapshotRef(s), tab_id: e.targetId + 1000 },
      { ...snapshotRef(s), task_id: 'other-task' },
    ]) {
      const reply = await message(
        e.panel,
        'scan.locate',
        { ref, field_id: f.field_id },
        s.task_id,
      );
      expect(reply.error.code).toBe('SCOPE_DENIED');
    }
    expect(
      (
        await message(
          e.panel,
          'scan.locate',
          { ref: { ...snapshotRef(s), frame_id: 1 }, field_id: f.field_id },
          s.task_id,
        )
      ).error.code,
    ).toBe('INVALID_REQUEST');
    expect(
      (
        await message(
          e.panel,
          'scan.locate',
          { ref: snapshotRef(s), field_id: 'nonexistent-field' },
          s.task_id,
        )
      ).error.code,
    ).toBe('FIELD_NOT_FOUND');
    const web = await e.context.newPage();
    await web.goto('http://localhost:3000');
    const external = await web.evaluate(
      async (id) =>
        new Promise<{ error: { code: string } }>((resolve) =>
          chrome.runtime.sendMessage(
            id,
            {
              protocol_version: '1',
              request_id: 'external-scan',
              task_id: null,
              method: 'scan.start',
              tab_id: 1,
            },
            resolve,
          ),
        ),
      e.id,
    );
    expect(external.error.code).toBe('INVALID_REQUEST');
    const blocked = await e.context.newPage();
    await blocked.goto('http://localhost:3000/m2-fixtures/basic.html');
    const blockedId = await e.panel.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => tab.id !== undefined && tab.active)?.id;
    });
    expect(blockedId).toBeDefined();
    const denied = await message(
      e.panel,
      'scan.start',
      { tab_id: blockedId },
      null,
    );
    expect(denied.error.code).toBe('PERMISSION_DENIED');
  } finally {
    await e.context.close();
    await rm(e.dir, { recursive: true, force: true });
  }
});
test('worker 重启后从会话元数据与页面恢复，页面刷新后不能沿用旧快照', async () => {
  const e = await setup('basic.html');
  try {
    await e.panel
      .getByRole('button', { name: '开始扫描', exact: true })
      .click();
    await expect(e.panel.getByTestId('scan-summary')).toContainText(
      '12 个字段',
    );
    const first = (await data(e.panel)).snapshot!;
    const cdp = await e.context.newCDPSession(e.panel);
    const versions = new Map<
      string,
      { versionId: string; scriptURL: string; runningStatus: string }
    >();
    const stopped = new Set<string>();
    cdp.on('ServiceWorker.workerVersionUpdated', (event) => {
      for (const version of event.versions) {
        versions.set(version.versionId, version);
        if (version.runningStatus === 'stopped') stopped.add(version.versionId);
      }
    });
    await cdp.send('ServiceWorker.enable');
    await expect
      .poll(() =>
        [...versions.values()].some(
          (version) => version.scriptURL === e.worker.url(),
        ),
      )
      .toBe(true);
    const worker = [...versions.values()].find(
      (version) => version.scriptURL === e.worker.url(),
    )!;
    await cdp.send('ServiceWorker.stopWorker', { versionId: worker.versionId });
    await expect.poll(() => stopped.has(worker.versionId)).toBe(true);
    await expect
      .poll(async () => {
        try {
          return (
            (await data(e.panel)).snapshot?.form_snapshot_id ===
            first.form_snapshot_id
          );
        } catch {
          return false;
        }
      })
      .toBe(true);
    const recovered = await data(e.panel);
    expect(recovered.snapshot?.form_snapshot_id).toBe(first.form_snapshot_id);
    expect(recovered.session?.task_id).toBe(first.task_id);
    await e.fixture.reload();
    await expect.poll(async () => (await data(e.panel)).snapshot).toBeNull();
    const old = await message(
      e.panel,
      'scan.locate',
      { ref: snapshotRef(first), field_id: first.fields[0]!.field_id },
      first.task_id,
    );
    expect(old.error.code).toBe('SNAPSHOT_EXPIRED');
  } finally {
    await e.context.close();
    await rm(e.dir, { recursive: true, force: true });
  }
});
