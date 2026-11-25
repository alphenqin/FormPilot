import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { openExtension, createVault, unlockVault } from './extension';
async function stop(child: ChildProcess) {
  if (child.exitCode === null) {
    const done = once(child, 'exit');
    child.kill('SIGTERM');
    await done;
  }
}
async function setup() {
  const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'tests/fixtures/plan-api.ts'],
      { stdio: 'ignore' },
    ),
    e = await openExtension();
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch('http://127.0.0.1:4318/health')).ok) break;
      } catch {
        /* Wait. */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const page = e.page;
    await createVault(page);
    await page.getByLabel('补充值').fill('M4扩展合成同学');
    await page.getByRole('button', { name: '添加待确认事实' }).click();
    await page
      .locator('[data-fact-path="basic.name"]')
      .getByRole('button', { name: '确认事实' })
      .click();
    await page.getByLabel('本地 API 访问令牌').fill('c'.repeat(64));
    await page.getByRole('button', { name: '连接解析服务' }).click();
    await expect(page.getByRole('status')).toContainText('解析服务已连接');
    const fixture = await e.context.newPage();
    await fixture.goto('http://127.0.0.1:3000/m2-fixtures/execution.html');
    const worker = e.context.serviceWorkers()[0]!;
    const tab = await worker.evaluate(async () => {
      const t = (await chrome.tabs.query({})).find((t) =>
        t.url?.includes('/m2-fixtures/execution.html'),
      );
      return t!.id!;
    });
    const panel = await e.context.newPage();
    await panel.goto(`chrome-extension://${e.id}/sidepanel.html`);
    await panel.getByLabel('要扫描的标签页').selectOption(String(tab));
    await panel.getByRole('button', { name: '开始扫描', exact: true }).click();
    await expect(page.locator('.plan-panel')).toContainText('个字段');
    await page
      .getByRole('checkbox', {
        name: '同意本次向所示供应商发送字段数据生成计划',
      })
      .check();
    await page
      .getByRole('button', { name: '生成填充计划', exact: true })
      .click();
    const name = page
      .getByTestId('plan-field')
      .filter({ hasText: '姓名' })
      .first();
    await expect(name).toContainText('需明确保留或替换');
    await name.getByRole('button', { name: '确认替换为建议值' }).click();
    await expect(name).toContainText('可填');
    await page.getByRole('button', { name: /批准所选 \d+ 项/ }).click();
    await expect(page.getByTestId('plan-status')).toContainText(
      '已批准，可执行填写',
    );
    return { ...e, fixture, panel, child };
  } catch (error) {
    await e.context.close();
    await rm(e.dir, { recursive: true, force: true });
    await stop(child);
    throw error;
  }
}
async function start(page: Page) {
  await page
    .getByRole('button', { name: '填写已批准字段', exact: true })
    .click();
  await expect(page.locator('.execution-panel')).toContainText('1 项回读一致', {
    timeout: 15000,
  });
  await expect(page.locator('.execution-panel')).toContainText(
    '服务端已核对报告',
  );
}
test('实际扩展：批准后填写、核验、刷新与 worker 重启恢复、条件撤销，始终不提交', async () => {
  const e = await setup();
  try {
    await start(e.page);
    expect(await e.fixture.locator('#name').inputValue()).toBe(
      'M4扩展合成同学',
    );
    expect(await e.fixture.evaluate(() => window.submits)).toBe(0);
    expect(await e.fixture.locator('#consent').isChecked()).toBe(false);
    expect(await e.fixture.locator('#password').inputValue()).toBe(
      'M4_PASSWORD_SENTINEL',
    );
    await e.page.reload();
    await unlockVault(e.page);
    await expect(e.page.locator('.execution-panel')).toContainText(
      '1 项回读一致',
    );
    const cdp = await e.context.newCDPSession(e.page),
      versions = new Map<
        string,
        { versionId: string; scriptURL: string; runningStatus: string }
      >(),
      stopped = new Set<string>();
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
          (v) => v.scriptURL === e.context.serviceWorkers()[0]!.url(),
        ),
      )
      .toBe(true);
    const version = [...versions.values()].find((v) =>
      v.scriptURL.includes(e.id),
    )!;
    await cdp.send('ServiceWorker.stopWorker', {
      versionId: version.versionId,
    });
    await expect.poll(() => stopped.has(version.versionId)).toBe(true);
    await e.page.waitForTimeout(900);
    const health = await e.page.evaluate(() =>
      chrome.runtime.sendMessage({
        protocol_version: '1',
        request_id: crypto.randomUUID(),
        task_id: null,
        method: 'health',
      }),
    );
    expect(health.error).toBeNull();
    await e.page
      .getByRole('button', { name: '撤销本次填写', exact: true })
      .click();
    await expect(e.page.locator('.execution-panel')).toContainText(
      '1 项已恢复',
      { timeout: 15000 },
    );
    await expect(e.page.getByTestId('execution-status')).toContainText(
      '撤销已结束',
    );
    expect(await e.fixture.locator('#name').inputValue()).toBe('网页原姓名');
    expect(await e.fixture.evaluate(() => window.submits)).toBe(0);
    const stored = await e.page.evaluate(async () =>
      JSON.stringify(await chrome.storage.session.get(null)),
    );
    expect(stored).not.toContain('M4扩展合成同学');
    expect(stored).not.toContain('网页原姓名');
    await e.page.screenshot({
      path: 'test-results/m4-execution-undo.png',
      fullPage: true,
    });
  } finally {
    await e.context.close();
    await rm(e.dir, { recursive: true, force: true });
    await stop(e.child);
  }
});
test('实际扩展：用户改后再改回写入值，撤销仍保护该字段', async () => {
  const e = await setup();
  try {
    await start(e.page);
    await e.fixture.locator('#name').fill('用户之后改过');
    await e.fixture.locator('#name').fill('M4扩展合成同学');
    await e.page
      .getByRole('button', { name: '撤销本次填写', exact: true })
      .click();
    await expect(e.page.locator('.execution-panel')).toContainText(
      '用户已修改，保护该字段',
      { timeout: 15000 },
    );
    expect(await e.fixture.locator('#name').inputValue()).toBe(
      'M4扩展合成同学',
    );
    expect(await e.fixture.evaluate(() => window.submits)).toBe(0);
  } finally {
    await e.context.close();
    await rm(e.dir, { recursive: true, force: true });
    await stop(e.child);
  }
});
test('实际扩展：停止或替换扫描会停止旧执行并释放其执行锁', async () => {
  const e = await setup();
  try {
    await e.page
      .getByRole('button', { name: '填写已批准字段', exact: true })
      .click();
    await expect(e.fixture.locator('#name')).toHaveValue('M4扩展合成同学');
    const meta = await e.page.evaluate(async () => {
      const data = await chrome.storage.session.get('execution_session_v1');
      return data.execution_session_v1 as {
        task_id: string;
        workspace_id: string;
        execution_id: string;
      };
    });
    await e.panel
      .getByRole('button', { name: '停止扫描', exact: true })
      .click();
    await expect
      .poll(() =>
        e.page.evaluate(async (m) => {
          const data = await chrome.storage.session.get(
              'api_' + m.workspace_id,
            ),
            session = data['api_' + m.workspace_id] as {
              session_token: string;
            };
          const result = await fetch(
            'http://127.0.0.1:4318/v1/fill/tasks/' + m.task_id + '/executions',
            { headers: { Authorization: 'Bearer ' + session.session_token } },
          ).then((r) => r.json());
          const record = result.data.find(
            (r: { packet: { execution_id: string } }) =>
              r.packet.execution_id === m.execution_id,
          );
          return ['completed', 'interrupted'].includes(record.phase);
        }, meta),
      )
      .toBe(true);
    expect(await e.fixture.evaluate(() => window.submits)).toBe(0);
  } finally {
    await e.context.close();
    await rm(e.dir, { recursive: true, force: true });
    await stop(e.child);
  }
});
