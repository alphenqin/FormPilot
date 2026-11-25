import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openExtension, createVault, unlockVault } from './extension';
let child: ChildProcess;
test.beforeEach(async () => {
  child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/fixtures/answer-api.ts'],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch('http://127.0.0.1:4318/health')).ok) return;
    } catch {
      /* wait */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Test API did not start');
});
test.afterEach(async () => {
  if (child.exitCode === null && !child.killed) {
    const done = once(child, 'exit');
    child.kill('SIGTERM');
    await done;
  }
});
async function fact(page: Page, path: string, value: string, confirm = true) {
  await page.getByLabel('事实字段').selectOption(path);
  await page.getByLabel('补充值').fill(value);
  await page.getByRole('button', { name: '添加待确认事实' }).click();
  if (confirm)
    await page
      .locator(`[data-fact-path="${path}"]`)
      .last()
      .getByRole('button', { name: '确认事实' })
      .click();
}
async function setup(page: Page) {
  await createVault(page);
  await fact(page, 'basic.name', 'PRIVATE_NAME_NOT_SENT');
  await fact(
    page,
    'project.description',
    '使用Java实现接口，未负责数据库优化。',
  );
  await fact(page, 'work.description', 'PENDING_NOT_SENT', false);
  const career = page.getByTestId('career-panel');
  await career.locator('summary').first().click();
  await career.getByLabel('岗位备注', { exact: true }).fill('合成后端岗位');
  await career.getByLabel('JD 原文', { exact: true }).fill('熟练掌握Java。');
  await career.getByRole('button', { name: '仅保存 JD 并手动标注' }).click();
  await career.getByText('从原文补充遗漏要求', { exact: true }).click();
  await career.getByLabel('补充要求原文').fill('熟练掌握Java。');
  await career.getByLabel('补充要求分类').selectOption('skill');
  await career.getByLabel('补充要求关键词').fill('Java');
  await career.getByRole('button', { name: '添加原文要求' }).click();
  await career.getByRole('button', { name: '确认已核对这些岗位要求' }).click();
  await page.getByLabel('本地 API 访问令牌').fill('c'.repeat(64));
  await page.getByRole('button', { name: '连接解析服务' }).click();
  await expect(page.getByRole('status')).toContainText('解析服务已连接');
  const panel = page.getByTestId('answer-panel');
  await panel.locator('summary').first().click();
  await panel
    .getByLabel('开放题问题', { exact: true })
    .fill('描述一次项目经历');
  await panel.getByRole('checkbox', { name: /^发送项目描述/ }).check();
  await expect(panel).not.toContainText('PRIVATE_NAME_NOT_SENT');
  await expect(panel).not.toContainText('PENDING_NOT_SENT');
  await expect(
    panel.getByRole('button', { name: '授权生成开放题草稿' }),
  ).toBeDisabled();
  return panel;
}
const grant = (page: Page) =>
  page
    .getByTestId('answer-panel')
    .getByRole('checkbox', {
      name: '同意本次将所示问题、岗位要求与选中事实发送给上述模型供应商',
    })
    .check();
const count = async () =>
  (
    (await (await fetch('http://127.0.0.1:4318/test/calls')).json()) as {
      calls: number;
    }
  ).calls;

test('开放题明确授权、完整引用、本人编辑与审核后复制导出；资料改变失效', async () => {
  const e = await openExtension();
  try {
    const page = e.page,
      panel = await setup(page);
    await grant(page);
    await panel.getByRole('button', { name: '授权生成开放题草稿' }).click();
    const editor = panel.getByLabel('本人修改后的答案', { exact: true });
    await expect(editor).toHaveValue(/未负责数据库优化/);
    await expect(
      panel.getByRole('button', { name: '我已修改并核实答案，审核此版本' }),
    ).toBeDisabled();
    await expect(
      panel.getByRole('button', { name: '导出审核后的答案' }),
    ).toBeDisabled();
    const generated = await editor.inputValue();
    await editor.fill(generated + '\n这是我核对后的项目经历说明。');
    await panel.getByRole('button', { name: '保存答案修改' }).click();
    await panel
      .getByRole('button', { name: '我已修改并核实答案，审核此版本' })
      .click();
    await panel.getByRole('button', { name: '复制审核后的答案' }).click();
    await expect(panel.getByTestId('answer-status')).toContainText(
      '已复制审核后的答案',
    );
    const download = page.waitForEvent('download');
    await panel.getByRole('button', { name: '导出审核后的答案' }).click();
    await (await download).saveAs(join(e.dir, 'answer.txt'));
    const output = await readFile(join(e.dir, 'answer.txt'), 'utf8');
    expect(output).toContain('未负责数据库优化');
    expect(output).toContain('核对后的项目经历说明');
    await editor.fill(output + '\n进一步核对。');
    await expect(
      panel.getByRole('button', { name: '导出审核后的答案' }),
    ).toBeDisabled();
    await panel.getByRole('button', { name: '放弃答案未保存修改' }).click();
    await fact(page, 'education.degree', '本科');
    await expect(panel.getByRole('alert')).toContainText('答案已过期');
    await expect(
      panel.getByRole('button', { name: '导出审核后的答案' }),
    ).toBeDisabled();
    expect(await count()).toBe(1);
  } finally {
    await e.context.close();
    await rm(e.dir, { recursive: true, force: true });
  }
});
test('生成期间锁定后恢复，不重复调用模型；重启后仍有草稿与修订历史', async () => {
  let e = await openExtension();
  const dir = e.dir;
  try {
    let page = e.page,
      panel = await setup(page);
    await grant(page);
    await panel.getByRole('button', { name: '授权生成开放题草稿' }).click();
    await expect(panel.getByTestId('answer-status')).toContainText(
      '开放题正在生成',
    );
    await page.getByRole('button', { name: '锁定资料库', exact: true }).click();
    await unlockVault(page);
    panel = page.getByTestId('answer-panel');
    await panel.locator('summary').first().click();
    await panel.getByRole('button', { name: '恢复开放题生成' }).click();
    await expect(
      panel.getByLabel('本人修改后的答案', { exact: true }),
    ).toHaveValue(/未负责数据库优化/);
    expect(await count()).toBe(1);
    const editor = panel.getByLabel('本人修改后的答案', { exact: true });
    await editor.fill((await editor.inputValue()) + '\n本人已核实。');
    await panel.getByRole('button', { name: '保存答案修改' }).click();
    await panel
      .getByRole('button', { name: '我已修改并核实答案，审核此版本' })
      .click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出加密备份' }).click();
    await (await download).saveAs(join(dir, 'backup.json'));
    expect(await readFile(join(dir, 'backup.json'), 'utf8')).not.toContain(
      '本人已核实',
    );
    await e.context.close();
    e = await openExtension(dir);
    page = e.page;
    await unlockVault(page);
    panel = page.getByTestId('answer-panel');
    await panel.locator('summary').first().click();
    await expect(
      panel.getByLabel('本人修改后的答案', { exact: true }),
    ).toHaveValue(/本人已核实/);
    await expect(
      panel.getByRole('button', { name: '导出审核后的答案' }),
    ).toBeEnabled();
    await panel.getByText('答案修订历史（2）', { exact: true }).click();
    await panel.getByRole('button', { name: '恢复答案 v2' }).click();
    await expect(
      panel.getByRole('button', { name: '导出审核后的答案' }),
    ).toBeDisabled();
  } finally {
    await e.context.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('启动响应丢失后只读恢复原请求，不重新付费；删除岗位级联清理答案', async () => {
  const e = await openExtension();
  try {
    const page = e.page,
      panel = await setup(page);
    await page.route('**/v1/career/answers/generate', async (route) => {
      await route.fetch();
      await route.abort('failed');
    });
    await grant(page);
    await panel.getByRole('button', { name: '授权生成开放题草稿' }).click();
    await expect(
      panel.getByRole('button', { name: '恢复开放题生成' }),
    ).toBeEnabled();
    await page.unroute('**/v1/career/answers/generate');
    await panel.getByRole('button', { name: '恢复开放题生成' }).click();
    await expect(
      panel.getByLabel('本人修改后的答案', { exact: true }),
    ).toHaveValue(/未负责数据库优化/);
    expect(await count()).toBe(1);
    await page
      .getByTestId('career-panel')
      .getByRole('button', { name: '删除此岗位、分析及岗位简历' })
      .click();
    await expect(
      panel.getByLabel('已保存开放题答案', { exact: true }),
    ).toHaveCount(0);
  } finally {
    await e.context.close();
    await rm(e.dir, { recursive: true, force: true });
  }
});
test('生成进行中可以取消，迟到结果不恢复为可用答案', async () => {
  const e = await openExtension();
  try {
    const page = e.page,
      panel = await setup(page);
    await grant(page);
    await panel.getByRole('button', { name: '授权生成开放题草稿' }).click();
    await expect(panel.getByTestId('answer-status')).toContainText(
      '开放题正在生成',
    );
    await panel.getByRole('button', { name: '取消开放题生成' }).click();
    await expect(panel.getByTestId('answer-status')).toContainText('已取消');
    await expect(
      panel.getByRole('button', { name: '恢复开放题生成' }),
    ).toHaveCount(0);
    await page.waitForTimeout(2200);
    await expect(
      panel.getByLabel('本人修改后的答案', { exact: true }),
    ).toHaveCount(0);
    expect(await count()).toBe(1);
  } finally {
    await e.context.close();
    await rm(e.dir, { recursive: true, force: true });
  }
});
