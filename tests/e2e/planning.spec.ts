import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { openExtension, createVault, unlockVault } from './extension';
test('实际扩展扫描→任务补答→原值冲突→新版本→批准→重启恢复→页面变化失效，全程不写网页', async () => {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/fixtures/plan-api.ts'],
    { stdio: 'ignore' },
  );
  const e = await openExtension();
  try {
    for (let i = 0; i < 100; i++) {
      try {
        const res = await fetch('http://127.0.0.1:4318/health');
        if (res.ok) break;
      } catch {
        /* wait */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const page = e.page;
    await createVault(page);
    await page.getByLabel('补充值').fill('M3浏览器合成同学');
    await page.getByRole('button', { name: '添加待确认事实' }).click();
    await page
      .locator('[data-fact-path="basic.name"]')
      .getByRole('button', { name: '确认事实' })
      .click();
    await page.getByLabel('本地 API 访问令牌').fill('c'.repeat(64));
    await page.getByRole('button', { name: '连接解析服务' }).click();
    await expect(page.getByRole('status')).toContainText('解析服务已连接');
    const fixture = await e.context.newPage();
    await fixture.goto('http://127.0.0.1:3000/m2-fixtures/basic.html');
    const worker = e.context.serviceWorkers()[0]!;
    const tab = await worker.evaluate(async () => {
      const t = (await chrome.tabs.query({})).find((t) =>
        t.url?.includes('/m2-fixtures/basic.html'),
      );
      return t!.id!;
    });
    const panel = await e.context.newPage();
    await panel.goto(`chrome-extension://${e.id}/sidepanel.html`);
    await panel.getByLabel('要扫描的标签页').selectOption(String(tab));
    await panel.getByRole('button', { name: '开始扫描', exact: true }).click();
    await expect(panel.getByTestId('scan-summary')).toContainText('12 个字段');
    await expect(page.locator('.plan-panel')).toContainText('12 个字段');
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
    const questions = page.locator('.plan-question');
    if (await questions.count()) {
      const q = questions.first();
      const input = q.locator('input');
      if (await input.count()) {
        await input.fill('task-only@example.test');
        await q.getByRole('button', { name: '保存本任务答案' }).click();
        await expect(page.getByTestId('plan-status')).toContainText('新版本');
      }
    }
    // M3 approves selected fill fields while unfilled ask/manual fields remain explicit.
    const reviews = page
      .getByTestId('plan-field')
      .filter({ has: page.locator('.pill', { hasText: '需审核' }) });
    while (await reviews.count()) {
      await reviews
        .first()
        .getByRole('button', { name: '转人工', exact: true })
        .click();
      await expect(page.getByTestId('plan-status')).toContainText('新版本');
    }
    const approve = page.getByRole('button', { name: /批准所选 \d+ 项/ });
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(page.getByTestId('plan-status')).toContainText(
      '已批准，可执行填写',
    );
    expect(await fixture.locator('#full-name').inputValue()).toBe(
      '合成测试同学',
    );
    expect(
      await fixture.evaluate(() => [window.writeEvents, window.submits]),
    ).toEqual([0, 0]);
    await page.reload();
    await unlockVault(page);
    await expect(page.getByTestId('plan-status')).toContainText(
      '已批准，可执行填写',
    );
    await fixture.locator('#full-name').fill('用户网页修改');
    await expect(page.locator('.plan-panel')).toContainText('计划已失效');
    await expect(
      page.getByRole('button', { name: /批准所选 \d+ 项/ }),
    ).toBeDisabled();
    await page.screenshot({
      path: 'test-results/m3-plan-invalidated.png',
      fullPage: true,
    });
    const saved = await worker.evaluate(async () =>
      JSON.stringify(await chrome.storage.session.get(null)),
    );
    expect(saved).not.toContain('M3浏览器合成同学');
    expect(saved).not.toContain('task-only@example.test');
  } finally {
    await e.context.close();
    await rm(e.dir, { recursive: true, force: true });
    if (child.exitCode === null) {
      const done = once(child, 'exit');
      child.kill('SIGTERM');
      await done;
    }
  }
});
