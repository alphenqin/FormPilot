import { test, expect } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { parseEnv } from 'node:util';
import {
  openExtension,
  createVault,
  unlockVault,
  vaultPassword,
} from './extension';
async function stop(child: ChildProcess) {
  if (child.exitCode === null && !child.killed) {
    const done = once(child, 'exit');
    child.kill('SIGTERM');
    await done;
  }
}
async function ready(child: ChildProcess) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null)
      throw new Error('临时 API 启动失败，请检查 4318 端口');
    try {
      const response = await fetch('http://127.0.0.1:4318/health');
      if (response.ok) return;
    } catch {
      /* 等待测试 API */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('API 未就绪');
}
test('本地导入、事实历史、口令更新、加密备份/恢复与删除', async () => {
  let extension = await openExtension();
  const dir = extension.dir;
  try {
    let page = extension.page;
    await createVault(page);
    await page
      .getByLabel('粘贴简历原文')
      .fill('姓名：浏览器测试同学\n仅用于自动化验证的合成资料');
    await page.getByRole('button', { name: '保存手动文本' }).click();
    await expect(page.getByRole('status')).toContainText('本地加密保存');
    await page.getByLabel('补充值').fill('BROWSER_PRIVATE_SENTINEL');
    await page.getByRole('button', { name: '添加待确认事实' }).click();
    let card = page.locator('[data-fact-path="basic.name"]');
    await expect(card).toContainText('待确认');
    await card.getByRole('button', { name: '确认事实' }).click();
    await expect(card).toContainText('已确认');
    await card.getByLabel('事实值', { exact: true }).fill('用户修改后');
    await card.getByRole('button', { name: '保存修改' }).click();
    await expect(card).toContainText('用户输入');
    await expect(card).toContainText('待确认');
    await expect(card).toContainText('历史版本（3）');
    const ciphertext = await page.evaluate(
      async () =>
        new Promise<string>((resolve, reject) => {
          const request = indexedDB.open('formpilot-vault');
          request.onsuccess = () => {
            const db = request.result;
            const get = db
              .transaction('records')
              .objectStore('records')
              .get('workspace');
            get.onsuccess = () => {
              resolve(JSON.stringify(get.result));
              db.close();
            };
            get.onerror = () => reject(get.error);
          };
        }),
    );
    expect(ciphertext).not.toContain('BROWSER_PRIVATE_SENTINEL');
    expect(ciphertext).not.toContain('浏览器测试同学');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出加密备份' }).click();
    const backup = await download;
    const path = join(dir, 'encrypted-backup.json');
    await backup.saveAs(path);
    expect(await readFile(path, 'utf8')).not.toContain(
      'BROWSER_PRIVATE_SENTINEL',
    );
    await page.locator('summary').filter({ hasText: '修改资料库口令' }).click();
    await page.getByLabel('原口令', { exact: true }).fill(vaultPassword);
    await page
      .getByLabel('新口令', { exact: true })
      .fill('new-test-vault-passphrase');
    await page.getByRole('button', { name: '更新口令并锁定' }).click();
    await expect(
      page.getByRole('heading', { name: '解锁资料库' }),
    ).toBeVisible();
    await unlockVault(page, 'new-test-vault-passphrase');
    await extension.context.close();
    extension = await openExtension(dir);
    page = extension.page;
    await expect(
      page.getByRole('heading', { name: '解锁资料库' }),
    ).toBeVisible();
    await unlockVault(page, 'new-test-vault-passphrase');
    card = page.locator('[data-fact-path="basic.name"]');
    await expect(card.getByLabel('事实值')).toHaveValue('用户修改后');
    await page.locator('summary').filter({ hasText: '删除全部资料' }).click();
    await page.getByLabel('输入 DELETE 确认删除').fill('DELETE');
    await page
      .getByRole('button', { name: '删除全部资料', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: '建立加密资料库' }),
    ).toBeVisible();
    await page.getByLabel('资料库口令', { exact: true }).fill(vaultPassword);
    await page.getByLabel('从加密备份恢复').setInputFiles(path);
    await expect(
      page.getByRole('heading', { name: '解锁资料库' }),
    ).toBeVisible();
    await unlockVault(page);
    await expect(
      page.locator('[data-fact-path="basic.name"]').getByLabel('事实值'),
    ).toHaveValue('用户修改后');
    await page.screenshot({
      path: 'test-results/m1-workspace.png',
      fullPage: true,
    });
  } finally {
    await extension.context.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('真实 PDF worker 提取页码，无文本 PDF 明确提示', async () => {
  const extension = await openExtension();
  try {
    const page = extension.page;
    await createVault(page);
    await page
      .getByLabel('选择 PDF 或 TXT')
      .setInputFiles(resolve('tests/fixtures/resumes/synthetic.pdf'));
    await expect(page.getByRole('status')).toContainText('本地加密保存');
    await page
      .locator('summary')
      .filter({ hasText: '查看完整提取文本' })
      .click();
    await expect(page.getByText('第 1 页', { exact: false })).toBeVisible();
    await expect(
      page.locator('pre').filter({ hasText: 'Synthetic Resume Only' }),
    ).toContainText('Synthetic Resume Only');
    await page
      .getByLabel('选择 PDF 或 TXT')
      .setInputFiles(resolve('tests/fixtures/resumes/scan-without-text.pdf'));
    await expect(page.getByRole('status')).toContainText('没有可提取文本');
  } finally {
    await extension.context.close();
    await rm(extension.dir, { recursive: true, force: true });
  }
});
test('受控模型：授权解析、页面关闭后恢复任务与逐项确认', async () => {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/fixtures/profile-api.ts'],
    { stdio: 'ignore' },
  );
  const extension = await openExtension();
  try {
    await ready(child);
    const page = extension.page;
    await createVault(page);
    await page
      .getByLabel('粘贴简历原文')
      .fill('姓名：测试同学\n合成样本，非真实简历');
    await page.getByRole('button', { name: '保存手动文本' }).click();
    await expect(page.getByRole('status')).toContainText('本地加密保存');
    await page.getByLabel('本地 API 访问令牌').fill('c'.repeat(64));
    await page.getByRole('button', { name: '连接解析服务' }).click();
    await expect(page.getByRole('status')).toContainText('解析服务已连接');
    await expect(
      page.getByRole('button', { name: '授权并解析当前文档' }),
    ).toBeDisabled();
    await page
      .getByRole('checkbox', {
        name: '我同意将当前文档提取文本发送给上述供应商，用于生成待确认事实。',
      })
      .check();
    await page.getByRole('button', { name: '连接解析服务' }).click();
    await expect(
      page.getByRole('button', { name: '连接解析服务' }),
    ).toBeEnabled();
    await expect(
      page.getByRole('checkbox', {
        name: '我同意将当前文档提取文本发送给上述供应商，用于生成待确认事实。',
      }),
    ).not.toBeChecked();
    await page
      .getByRole('checkbox', {
        name: '我同意将当前文档提取文本发送给上述供应商，用于生成待确认事实。',
      })
      .check();
    await page.getByRole('button', { name: '授权并解析当前文档' }).click();
    await expect(page.getByRole('status')).toContainText('任务已保存在本地');
    await page.reload();
    await unlockVault(page);
    await page.getByRole('button', { name: '连接解析服务' }).click();
    await expect(
      page.getByRole('button', { name: '恢复解析任务' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '恢复解析任务' }).click();
    await expect(page.getByRole('status')).toContainText('解析完成');
    const card = page.locator('[data-fact-path="basic.name"]');
    await expect(card).toContainText('待确认');
    await expect(card.locator('mark')).toHaveText('姓名：测试同学');
    await card.getByRole('button', { name: '确认事实' }).click();
    await expect(card).toContainText('已确认');
    await page.screenshot({
      path: 'test-results/m1-controlled-parse.png',
      fullPage: true,
    });
  } finally {
    await extension.context.close();
    await rm(extension.dir, { recursive: true, force: true });
    await stop(child);
  }
});
test('真实 DeepSeek：合成文本导入、证据审核与重启恢复', async () => {
  test.skip(
    process.env.FORMPILOT_LIVE_MODEL_TEST !== '1',
    '显式开启才调用付费真实模型；样本完全虚构',
  );
  test.setTimeout(90000);
  const env = parseEnv(await readFile('.env', 'utf8'));
  const child = spawn(
    process.execPath,
    ['--env-file=.env', 'apps/api/dist/server.js'],
    { stdio: 'ignore' },
  );
  let extension = await openExtension();
  const dir = extension.dir;
  try {
    await ready(child);
    let page = extension.page;
    await createVault(page);
    await page
      .getByLabel('粘贴简历原文')
      .fill(
        '完全虚构的技术验收样本\n姓名：模型测试同学\n邮箱：synthetic@example.test\n教育：示例大学，本科，2020年9月 至 2024年6月。',
      );
    await page.getByRole('button', { name: '保存手动文本' }).click();
    await expect(page.getByRole('status')).toContainText('本地加密保存');
    await page.getByLabel('本地 API 访问令牌').fill(env.FORMPILOT_API_TOKEN!);
    await page.getByRole('button', { name: '连接解析服务' }).click();
    await expect(page.getByRole('status')).toContainText('解析服务已连接');
    await page
      .getByRole('checkbox', {
        name: '我同意将当前文档提取文本发送给上述供应商，用于生成待确认事实。',
      })
      .check();
    await page.getByRole('button', { name: '授权并解析当前文档' }).click();
    await expect(page.getByRole('status')).toContainText('解析完成', {
      timeout: 65000,
    });
    const card = page.locator('[data-fact-path="basic.name"]');
    await expect(card).toContainText('待确认');
    await expect(card.getByLabel('事实值')).toHaveValue('模型测试同学');
    await card.getByRole('button', { name: '确认事实' }).click();
    await expect(card).toContainText('已确认');
    const count = await page.locator('.fact').count();
    for (const candidate of await page.locator('.fact').all()) {
      const button = candidate.getByRole('button', { name: '确认事实' });
      if ((await candidate.locator('.pill.confirmed').count()) === 0) {
        await expect(button).toBeEnabled();
        await button.click();
        await expect(candidate.locator('.pill.confirmed')).toBeVisible();
      }
    }
    await expect(page.locator('.fact .pill.confirmed')).toHaveCount(count);
    await page.screenshot({
      path: 'test-results/m1-live-deepseek.png',
      fullPage: true,
    });
    await extension.context.close();
    extension = await openExtension(dir);
    page = extension.page;
    await unlockVault(page);
    await expect(page.locator('[data-fact-path="basic.name"]')).toContainText(
      '已确认',
    );
  } finally {
    await extension.context.close();
    await rm(dir, { recursive: true, force: true });
    await stop(child);
  }
});
