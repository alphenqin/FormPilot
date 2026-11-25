import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openExtension, createVault, unlockVault } from './extension';

test('JD 页面读取→明确授权→原文审阅→本地证据匹配→失效→加密恢复', async () => {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/fixtures/career-api.ts'],
    { stdio: 'ignore' },
  );
  const e = await openExtension();
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch('http://127.0.0.1:4318/health')).ok) break;
      } catch {
        /* wait */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const page = e.page;
    await createVault(page);
    await page.getByLabel('本地 API 访问令牌').fill('c'.repeat(64));
    await page.getByRole('button', { name: '连接解析服务' }).click();
    await expect(page.getByRole('status')).toContainText('解析服务已连接');
    const fixture = await e.context.newPage();
    await fixture.goto(
      'http://127.0.0.1:3000/m2-fixtures/career.html?secret=URL_PRIVATE_SENTINEL',
    );
    const tab = await e.context
      .serviceWorkers()[0]!
      .evaluate(
        async () =>
          (await chrome.tabs.query({})).find((t) =>
            t.url?.includes('/career.html'),
          )!.id!,
      );
    const panel = page.getByTestId('career-panel');
    await panel.locator('summary').first().click();
    await panel.getByRole('button', { name: '刷新岗位标签页' }).click();
    await panel
      .getByLabel('岗位标签页', { exact: true })
      .selectOption(String(tab));
    await panel.getByRole('button', { name: '读取岗位正文' }).click();
    await expect(panel.getByLabel('JD 原文', { exact: true })).toContainText(
      '',
    );
    await expect(panel.getByLabel('JD 原文', { exact: true })).toHaveValue(
      /本科及以上/,
    );
    const captured = await panel
      .getByLabel('JD 原文', { exact: true })
      .inputValue();
    expect(captured).not.toContain('PRIVATE_SENTINEL');
    await expect(panel).not.toContainText('URL_PRIVATE_SENTINEL');
    await expect(
      panel.getByRole('button', { name: '授权解析 JD', exact: true }),
    ).toBeDisabled();
    await panel
      .getByRole('checkbox', {
        name: '同意本次将所示 JD 原文发送给上述模型供应商',
      })
      .check();
    await panel
      .getByRole('button', { name: '授权解析 JD', exact: true })
      .click();
    await expect(panel.getByTestId('career-status')).toContainText(
      'JD 正在解析',
    );
    await page.getByRole('button', { name: '锁定资料库', exact: true }).click();
    await unlockVault(page);
    await panel.locator('summary').first().click();
    await panel.getByRole('button', { name: '恢复 JD 解析' }).click();
    await expect(
      panel.getByRole('button', { name: '确认已核对这些岗位要求' }),
    ).toBeEnabled();
    await expect(
      panel.getByRole('button', { name: '开始本地岗位匹配' }),
    ).toBeDisabled();
    await panel.getByRole('button', { name: '定位 JD 原文' }).first().click();
    await expect(panel.getByTestId('job-original').locator('mark')).toHaveText(
      '本科及以上学历。',
    );
    await panel.getByRole('button', { name: '确认已核对这些岗位要求' }).click();
    await panel.getByRole('button', { name: '开始本地岗位匹配' }).click();
    await expect(panel.getByTestId('job-match')).toBeVisible();
    await expect(panel.getByTestId('job-match')).toContainText('待确认');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出加密备份' }).click();
    const file = join(e.dir, 'career-backup.json');
    await (await download).saveAs(file);
    expect(await readFile(file, 'utf8')).not.toContain('合成后端工程师');
    await page.getByLabel('补充值').fill('合成用户');
    await page.getByRole('button', { name: '添加待确认事实' }).click();
    await expect(panel.getByTestId('job-match')).toContainText('已过期');
    await page.getByRole('button', { name: '锁定资料库', exact: true }).click();
    await unlockVault(page);
    await page.getByTestId('career-panel').locator('summary').first().click();
    await expect(page.getByTestId('job-original')).toContainText(
      '本科及以上学历。',
    );
    await expect(page.getByTestId('job-match')).toContainText('已过期');
  } finally {
    await e.context.close();
    if (child.exitCode === null && !child.killed) {
      const done = once(child, 'exit');
      child.kill('SIGTERM');
      await done;
    }
    await rm(e.dir, { recursive: true, force: true });
  }
});

test('离线人工要求：只使用确认事实、导出证据与修订失效', async () => {
  const e = await openExtension();
  try {
    const page = e.page;
    await createVault(page);
    await page.getByLabel('事实字段').selectOption('education.degree');
    await page.getByLabel('补充值').fill('本科');
    await page.getByRole('button', { name: '添加待确认事实' }).click();
    const panel = page.getByTestId('career-panel');
    await panel.locator('summary').first().click();
    await panel.getByLabel('JD 原文', { exact: true }).fill('本科及以上学历。');
    await panel.getByRole('button', { name: '仅保存 JD 并手动标注' }).click();
    await panel.getByText('从原文补充遗漏要求', { exact: true }).click();
    await panel.getByLabel('补充要求原文').fill('本科及以上学历。');
    await panel.getByLabel('补充要求分类').selectOption('education');
    await panel.getByRole('button', { name: '添加原文要求' }).click();
    await panel.getByRole('button', { name: '确认已核对这些岗位要求' }).click();
    await panel.getByRole('button', { name: '开始本地岗位匹配' }).click();
    await expect(panel.getByTestId('job-match-row')).toContainText('待确认');
    await page
      .locator('[data-fact-path="education.degree"]')
      .getByRole('button', { name: '确认事实' })
      .click();
    await expect(panel.getByTestId('job-match')).toContainText('结果已过期');
    await panel.getByRole('button', { name: '开始本地岗位匹配' }).click();
    await expect(panel.getByTestId('job-match-row')).toContainText(
      '已确认的学历名称满足',
    );
    await expect(panel.getByTestId('job-match-row')).toContainText('用户确认');
    const download = page.waitForEvent('download');
    await panel.getByRole('button', { name: '导出岗位证据对照' }).click();
    const report = join(e.dir, 'report.md');
    await (await download).saveAs(report);
    expect(await readFile(report, 'utf8')).toContain('本科及以上学历。');
    expect(await readFile(report, 'utf8')).toContain('本科（用户确认');
    await panel
      .getByLabel('要求级别', { exact: true })
      .selectOption('preferred');
    await panel.getByRole('button', { name: '保存要求修改' }).click();
    await expect(panel.getByTestId('job-match')).toContainText('结果已过期');
    await expect(
      panel.getByRole('button', { name: '开始本地岗位匹配' }),
    ).toBeDisabled();
  } finally {
    await e.context.close();
    await rm(e.dir, { recursive: true, force: true });
  }
});
