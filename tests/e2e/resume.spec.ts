import { test, expect, type Page } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { openExtension, createVault, unlockVault } from './extension';
async function fact(page: Page, path: string, value: string, confirm = true) {
  await page.getByLabel('事实字段').selectOption(path);
  await page.getByLabel('补充值').fill(value);
  await page.getByRole('button', { name: '添加待确认事实' }).click();
  const card = page.locator(`[data-fact-path="${path}"]`).last();
  if (confirm) await card.getByRole('button', { name: '确认事实' }).click();
}
async function job(page: Page, title = '合成岗位', quote = '本科及以上学历。') {
  const panel = page.getByTestId('career-panel');
  if (!(await panel.getAttribute('open'))) {
    if (!(await panel.evaluate((el) => (el as HTMLDetailsElement).open)))
      await panel.locator('summary').first().click();
  }
  await panel.getByLabel('岗位备注', { exact: true }).fill(title);
  await panel.getByLabel('JD 原文', { exact: true }).fill(quote);
  await panel.getByRole('button', { name: '仅保存 JD 并手动标注' }).click();
  const extra = panel.getByText('从原文补充遗漏要求', { exact: true });
  if (
    !(await extra.evaluate(
      (el) => (el.parentElement as HTMLDetailsElement).open,
    ))
  )
    await extra.click();
  await panel.getByLabel('补充要求原文').fill(quote);
  await panel.getByLabel('补充要求分类').selectOption('education');
  await panel.getByRole('button', { name: '添加原文要求' }).click();
  await panel.getByRole('button', { name: '确认已核对这些岗位要求' }).click();
  return panel.getByLabel('已保存岗位', { exact: true }).inputValue();
}
const approve = (page: Page) =>
  page
    .getByTestId('resume-panel')
    .getByRole('button', { name: '我已核对正文与来源，审核此版本' })
    .click();

test('离线岗位简历：确认事实→编排→审核→安全导出与打印，修改清除审核', async () => {
  const e = await openExtension();
  try {
    const page = e.page,
      posts: string[] = [];
    e.context.on('request', (r) => {
      if (r.method() === 'POST' && /^https?:/.test(r.url()))
        posts.push(r.url());
    });
    await createVault(page);
    await fact(page, 'basic.name', 'RESUME_PRIVATE_合成同学');
    await fact(page, 'basic.phone', '13800138000', false);
    await fact(page, 'education.degree', '本科');
    await fact(page, 'basic.gender', '合成性别');
    const payload =
      '<script>window.resumeInjected=true</script>\n已确认的项目内容';
    await fact(page, 'project.description', payload);
    await job(page);
    const panel = page.getByTestId('resume-panel');
    await panel.locator('summary').first().click();
    await panel.getByLabel('新简历版本名称').fill('合成岗位版');
    await panel
      .getByRole('button', { name: '生成岗位版简历', exact: true })
      .click();
    await expect(panel.getByTestId('resume-preview')).toContainText(
      'RESUME_PRIVATE_合成同学',
    );
    await expect(panel.getByTestId('resume-preview')).not.toContainText(
      '13800138000',
    );
    await expect(panel.getByTestId('resume-preview')).not.toContainText(
      '合成性别',
    );
    await expect(panel.getByTestId('resume-preview')).toContainText(payload);
    await expect(
      panel.getByRole('button', { name: '导出可打印 HTML' }),
    ).toBeDisabled();
    await approve(page);
    for (const [button, filename] of [
      ['导出岗位简历 Markdown', 'resume.md'],
      ['导出可打印 HTML', 'resume.html'],
    ]) {
      const download = page.waitForEvent('download');
      await panel.getByRole('button', { name: button! }).click();
      await (await download).saveAs(join(e.dir, filename!));
    }
    const md = await readFile(join(e.dir, 'resume.md'), 'utf8'),
      html = await readFile(join(e.dir, 'resume.html'), 'utf8');
    expect(md).toContain('RESUME');
    expect(md).not.toContain('13800138000');
    expect(html).not.toContain('<script>');
    const printable = await e.context.newPage();
    await printable.goto(
      'data:text/html;charset=utf-8,' + encodeURIComponent(html),
    );
    expect(await printable.evaluate(() => 'resumeInjected' in window)).toBe(
      false,
    );
    await expect(printable.getByRole('heading', { level: 1 })).toHaveText(
      'RESUME_PRIVATE_合成同学',
    );
    const pdf = await printable.pdf({ format: 'A4' });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    await printable.close();
    await panel.getByRole('checkbox', { name: /^选入项目描述：/ }).uncheck();
    await expect(panel.getByTestId('resume-preview')).not.toContainText(
      '已确认的项目内容',
    );
    await expect(
      panel.getByRole('button', { name: '导出可打印 HTML' }),
    ).toBeDisabled();
    await panel.getByRole('button', { name: '保存简历编排' }).click();
    await expect(
      panel.getByRole('button', { name: '导出可打印 HTML' }),
    ).toBeDisabled();
    await panel.getByText('简历修订历史（2）', { exact: true }).click();
    await panel.getByRole('button', { name: '恢复简历 v2 的编排' }).click();
    await expect(panel.getByTestId('resume-preview')).toContainText(
      '已确认的项目内容',
    );
    await expect(
      panel.getByRole('button', { name: '导出可打印 HTML' }),
    ).toBeDisabled();
    expect(posts).toEqual([]);
  } finally {
    await e.context.close();
    await rm(e.dir, { recursive: true, force: true });
  }
});

test('资料变化阻止旧导出，新版本保留选择；切换、重启与加密备份可恢复', async () => {
  let e = await openExtension();
  const dir = e.dir;
  try {
    let page = e.page;
    await createVault(page);
    await fact(page, 'basic.name', '版本合成同学');
    await fact(page, 'education.degree', '本科');
    await job(page);
    let panel = page.getByTestId('resume-panel');
    await panel.locator('summary').first().click();
    await panel.getByLabel('新简历版本名称').fill('原简历');
    await panel
      .getByRole('button', { name: '生成岗位版简历', exact: true })
      .click();
    await approve(page);
    const firstId = await panel.getByLabel('已保存岗位简历').inputValue();
    await fact(page, 'work.company', '新增工作单位');
    await expect(panel.getByRole('alert')).toContainText('简历已过期');
    await expect(
      panel.getByRole('button', { name: '导出可打印 HTML' }),
    ).toBeDisabled();
    await panel
      .getByRole('button', { name: '基于最新资料生成独立新版本' })
      .click();
    await expect(panel.getByTestId('resume-preview')).toContainText(
      '新增工作单位',
    );
    const secondId = await panel.getByLabel('已保存岗位简历').inputValue();
    expect(secondId).not.toBe(firstId);
    await panel.getByLabel('已保存岗位简历').selectOption(firstId);
    await expect(panel.getByTestId('resume-preview')).not.toContainText(
      '新增工作单位',
    );
    await expect(panel.getByRole('alert')).toContainText('简历已过期');
    await panel.getByLabel('已保存岗位简历').selectOption(secondId);
    await approve(page);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出加密备份' }).click();
    await (await download).saveAs(join(dir, 'backup.json'));
    const backup = await readFile(join(dir, 'backup.json'), 'utf8');
    expect(backup).not.toContain('新增工作单位');
    expect(backup).not.toContain('原简历');
    await e.context.close();
    e = await openExtension(dir);
    page = e.page;
    await unlockVault(page);
    panel = page.getByTestId('resume-panel');
    await panel.locator('summary').first().click();
    await expect(panel.getByTestId('resume-preview')).toContainText(
      '新增工作单位',
    );
    await expect(
      panel.getByRole('button', { name: '导出可打印 HTML' }),
    ).toBeEnabled();
    await expect(
      panel.getByLabel('已保存岗位简历').locator('option'),
    ).toHaveCount(2);
  } finally {
    await e.context.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('不同岗位保留独立简历，岗位修订失效及删除级联清理', async () => {
  const e = await openExtension();
  try {
    const page = e.page;
    await createVault(page);
    await fact(page, 'basic.name', '多岗位同学');
    await fact(page, 'education.degree', '本科');
    const firstJob = await job(page, '甲岗位');
    const panel = page.getByTestId('resume-panel');
    await panel.locator('summary').first().click();
    await panel.getByLabel('新简历版本名称').fill('甲简历');
    await panel
      .getByRole('button', { name: '生成岗位版简历', exact: true })
      .click();
    await approve(page);
    const secondJob = await job(page, '乙岗位', '硕士及以上学历。');
    await panel.getByLabel('简历目标岗位').selectOption(secondJob);
    await expect(panel.getByTestId('resume-preview')).toHaveCount(0);
    await panel.getByLabel('新简历版本名称').fill('乙简历');
    await panel
      .getByRole('button', { name: '生成岗位版简历', exact: true })
      .click();
    await expect(panel.getByLabel('已保存岗位简历')).toContainText('乙简历');
    await panel.getByLabel('简历目标岗位').selectOption(firstJob);
    await expect(panel.getByLabel('已保存岗位简历')).toContainText('甲简历');
    const career = page.getByTestId('career-panel');
    await career
      .getByLabel('已保存岗位', { exact: true })
      .selectOption(firstJob);
    await career
      .getByLabel('要求级别', { exact: true })
      .selectOption('preferred');
    await career.getByRole('button', { name: '保存要求修改' }).click();
    await expect(panel.getByRole('alert')).toContainText('简历已过期');
    await career
      .getByRole('button', { name: '删除此岗位、分析及岗位简历' })
      .click();
    await expect(panel.getByLabel('已保存岗位简历')).toContainText('乙简历');
    await expect(
      panel.getByLabel('简历目标岗位').locator('option'),
    ).toHaveCount(2);
  } finally {
    await e.context.close();
    await rm(e.dir, { recursive: true, force: true });
  }
});
