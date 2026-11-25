import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { FormSnapshot, ScanRef } from '@formpilot/contracts';
import type { FormScanner } from '@formpilot/browser-engine';
declare global {
  interface Window {
    __m2Scanner: FormScanner;
    writeEvents: number;
    submits: number;
  }
}
async function initialize(page: Page, name: string) {
  await page.goto('http://127.0.0.1:3000/m2-fixtures/' + name);
  await page.evaluate(
    async (modulePath) => {
      const { FormScanner } = await import(modulePath);
      window.__m2Scanner = new FormScanner({
        task_id: crypto.randomUUID(),
        tab_id: 100,
        started_at: Date.now(),
        expires_at: Date.now() + 60000,
      });
    },
    '/@fs' + resolve('packages/browser-engine/src/index.ts'),
  );
}
async function snapshot(page: Page, force = false): Promise<FormSnapshot> {
  return page.evaluate((force) => window.__m2Scanner.scan(force), force);
}
function ref(s: FormSnapshot): ScanRef {
  return {
    task_id: s.task_id,
    tab_id: s.tab_id,
    frame_id: 0,
    page_instance_id: s.page_instance_id,
    form_snapshot_id: s.form_snapshot_id,
    dom_fingerprint: s.dom_fingerprint,
  };
}
test('模板一：原生字段、约束、选项、当前值与敏感信息排除', async ({ page }) => {
  await initialize(page, 'basic.html');
  const s = await snapshot(page);
  expect(s.fields).toHaveLength(12);
  const byName = (name: string) => s.fields.find((f) => f.name === name)!;
  expect(byName('full_name')).toMatchObject({
    label: '姓名',
    label_source: 'label',
    required: true,
    current_value: '合成测试同学',
    constraints: { min_length: 2, max_length: 30 },
  });
  expect(byName('degree')).toMatchObject({
    label: '最高学历',
    current_value: 'bachelor',
    option_count: 3,
  });
  expect(byName('phone').control_type).toBe('phone');
  expect(byName('birth')).toMatchObject({
    control_type: 'date',
    constraints: { min: '1990-01-01', max: '2030-12-31' },
  });
  expect(byName('availability')).toMatchObject({
    label: '到岗时间',
    control_type: 'radio',
    current_value: 'later',
    option_count: 2,
  });
  expect(byName('consent').current_value).toBe(false);
  expect(byName('resume')).toMatchObject({
    supported: false,
    manual_reason: 'FILE_MANUAL',
    current_value: null,
    constraints: { accept: '.pdf,.txt', multiple: true },
  });
  expect(byName('source')).toMatchObject({ read_only: true, supported: false });
  expect(byName('job_code')).toMatchObject({
    enabled: false,
    supported: false,
  });
  for (const text of [
    'UNRELATED_PAGE_PRIVATE_SENTINEL',
    'HIDDEN_CSRF_SECRET_SENTINEL',
    'CSS_HIDDEN_SECRET_SENTINEL',
    'PASSWORD_SECRET_SENTINEL',
    'OTP_SECRET_SENTINEL',
    'CARD_SECRET_SENTINEL',
  ])
    expect(JSON.stringify(s)).not.toContain(text);
  expect(s.excluded.sensitive).toBe(3);
  expect(
    await page.evaluate(() => [window.writeEvents, window.submits]),
  ).toEqual([0, 0]);
});
test('模板二：重复标签按经历分组，自定义控件与 iframe/Shadow DOM 明确人工处理', async ({
  page,
}) => {
  await initialize(page, 'dynamic.html');
  const s = await snapshot(page);
  const companies = s.fields.filter((f) => f.name === 'company');
  expect(companies).toHaveLength(2);
  expect(companies[0]!.field_id).not.toBe(companies[1]!.field_id);
  expect(companies[0]!.group_id).not.toBe(companies[1]!.group_id);
  expect(
    companies.map(
      (c) => s.groups.find((g) => g.group_id === c.group_id)?.label,
    ),
  ).toEqual(['工作经历一', '工作经历二']);
  expect(s.fields.find((f) => f.control_type === 'custom')).toMatchObject({
    label: '工作城市',
    supported: false,
    manual_reason: 'CUSTOM_CONTROL',
    current_value: null,
  });
  expect(s.fields.find((f) => f.name === 'website')).toMatchObject({
    label: '个人网站 链接',
    label_source: 'aria-labelledby',
    description: '仅填写公开链接',
    required: true,
  });
  expect(
    s.fields.filter((f) => f.manual_reason === 'DUPLICATE_HTML_ID'),
  ).toHaveLength(2);
  expect(s.warnings).toEqual(
    expect.arrayContaining([
      { code: 'IFRAME_NOT_SCANNED', count: 2 },
      { code: 'SHADOW_DOM_NOT_SCANNED', count: 1 },
    ]),
  );
  for (const secret of [
    'IFRAME_PRIVATE_SENTINEL',
    'SHADOW_PRIVATE_SENTINEL',
    'CUSTOM_HIDDEN_SECRET_SENTINEL',
  ])
    expect(JSON.stringify(s)).not.toContain(secret);
});
test('模板三：多选、禁用区域、表单外关联、超限和 ARIA', async ({ page }) => {
  await initialize(page, 'accessibility.html');
  const s = await snapshot(page);
  const f = (name: string) => s.fields.find((f) => f.name === name)!;
  expect(f('school')).toMatchObject({
    label: '学校',
    label_source: 'aria-label',
    required: true,
  });
  expect(f('skills')).toMatchObject({
    current_value: ['js', 'ts'],
    constraints: { multiple: true },
  });
  expect(f('skills').options.find((o) => o.value === 'go')?.disabled).toBe(
    true,
  );
  expect(f('fieldset-disabled').enabled).toBe(false);
  expect(f('legend-exception').enabled).toBe(true);
  expect(f('external-degree').form_id).toBe(f('school').form_id);
  expect(f('years')).toMatchObject({
    manual_reason: 'CONTROL_UNSUPPORTED',
    constraints: { min: '0', max: '30', step: '0.5' },
  });
  expect(f('many_options')).toMatchObject({
    option_count: 205,
    supported: false,
    manual_reason: 'OPTIONS_LIMIT',
  });
  expect(s.complete).toBe(false);
  expect(f('postcode').current_value).toBe('100000');
  expect(JSON.stringify(s)).not.toContain('PAYMENT_PRIVATE_SENTINEL');
  expect(JSON.stringify(s)).not.toContain('EDITABLE_PRIVATE_SENTINEL');
});
test('稳定定位与旧快照守卫：值变化、同 ID 节点替换和路由变化', async ({
  page,
}) => {
  await initialize(page, 'dynamic.html');
  const first = await snapshot(page);
  const field = first.fields.find((f) => f.name === 'company')!;
  await page.locator('#company-one').evaluate((node: HTMLInputElement) => {
    node.value = '用户修改';
  });
  const changed = await snapshot(page);
  expect(changed.dom_fingerprint).toBe(first.dom_fingerprint);
  expect(changed.form_snapshot_id).not.toBe(first.form_snapshot_id);
  expect(
    changed.fields.find((f) => f.field_id === field.field_id)?.current_value,
  ).toBe('用户修改');
  const old = await page.evaluate(
    async ({ reference, id }) => {
      try {
        await window.__m2Scanner.locate(reference, id);
        return 'unexpected-success';
      } catch (error) {
        return (error as Error).message;
      }
    },
    { reference: ref(first), id: field.field_id },
  );
  expect(old).toBe('STALE_SNAPSHOT');
  await page.locator('#replace-company').click();
  const replacement = await snapshot(page);
  expect(
    replacement.fields.find((f) => f.name === 'company')?.field_id,
  ).not.toBe(field.field_id);
  expect(replacement.dom_fingerprint).not.toBe(changed.dom_fingerprint);
  await page.locator('#route-change').click();
  const route = await snapshot(page);
  expect(route.page_instance_id).not.toBe(replacement.page_instance_id);
  expect(JSON.stringify(route)).not.toContain('URL_SECRET_SENTINEL');
  expect(JSON.stringify(route)).not.toContain('HASH_SECRET_SENTINEL');
});
test('装饰变化不失效，人工标注不改网页，定位只能在当前 task/page 内', async ({
  page,
}) => {
  await initialize(page, 'dynamic.html');
  const first = await snapshot(page);
  await page.locator('#decoration').evaluate((node) => {
    node.textContent = '装饰动画变化';
    node.classList.add('updated');
  });
  const same = await snapshot(page);
  expect(same.form_snapshot_id).toBe(first.form_snapshot_id);
  const field = same.fields.find((f) => f.name === 'company')!;
  const result = await page.evaluate(
    async ({ reference, id }) =>
      window.__m2Scanner.annotate(reference, id, '第一段工作单位'),
    { reference: ref(same), id: field.field_id },
  );
  expect(
    result.fields.find((f) => f.field_id === field.field_id)?.manual_label,
  ).toBe('第一段工作单位');
  expect(result.form_snapshot_id).not.toBe(same.form_snapshot_id);
  expect(await page.locator('#company-one').inputValue()).toBe('示例公司甲');
  const located = await page.evaluate(
    async ({ reference, id }) => window.__m2Scanner.locate(reference, id, true),
    { reference: ref(result), id: field.field_id },
  );
  expect(located.matched).toBe(true);
  const scope = await page.evaluate(
    async ({ reference, id }) => {
      try {
        await window.__m2Scanner.locate({ ...reference, tab_id: 200 }, id);
        return 'unexpected-success';
      } catch (error) {
        return (error as Error).message;
      }
    },
    { reference: ref(result), id: field.field_id },
  );
  expect(scope).toBe('SCOPE_DENIED');
});
test('MutationObserver 与事件触发动态重扫，停止后不再保留快照', async ({
  page,
}) => {
  await initialize(page, 'dynamic.html');
  const first = await snapshot(page);
  await page.evaluate(() => window.__m2Scanner.watch(() => undefined));
  await page.locator('#add-experience').click();
  await expect
    .poll(async () => {
      const s = await snapshot(page);
      return s.fields.filter((f) => f.name === 'company').length;
    })
    .toBe(3);
  const next = await snapshot(page);
  expect(next.dom_fingerprint).not.toBe(first.dom_fingerprint);
  await page
    .locator('[data-form-group]')
    .first()
    .evaluate((node) => node.remove());
  await expect
    .poll(
      async () =>
        (await snapshot(page)).fields.filter(
          (field) => field.name === 'company',
        ).length,
    )
    .toBe(2);
  await page.evaluate(() => window.__m2Scanner.stop());
  const result = await page.evaluate(async () => {
    try {
      await window.__m2Scanner.read();
      return 'unexpected-success';
    } catch (error) {
      return (error as Error).message;
    }
  });
  expect(result).toBe('SNAPSHOT_EXPIRED');
});
test('100 个原生字段扫描性能测量（20 次）', async ({ page }) => {
  await initialize(page, 'basic.html');
  await page.evaluate(() => {
    document.body.innerHTML = '<form id="benchmark"></form>';
    const form = document.querySelector('form')!;
    for (let i = 0; i < 100; i++) {
      const label = document.createElement('label');
      label.textContent = '测试字段 ' + i;
      const input = document.createElement('input');
      input.name = 'field_' + i;
      label.append(input);
      form.append(label);
    }
  });
  const result = await page.evaluate(async () => {
    const timings: number[] = [];
    for (let i = 0; i < 20; i++) {
      const s = await window.__m2Scanner.scan(true);
      if (s.fields.length !== 100) throw new Error('字段数错误');
      timings.push(s.duration_ms);
    }
    timings.sort((a, b) => a - b);
    return {
      samples: 20,
      fields: 100,
      p50_ms: timings[9],
      p95_ms: timings[18],
    };
  });
  console.log(JSON.stringify({ measurement: 'native-scan', ...result }));
  expect(result.p95_ms!).toBeLessThan(1000);
});

test('扫描上限明确不完整，附件不读取已选文件名或内容，过期快照拒绝定位', async ({
  page,
}) => {
  await initialize(page, 'basic.html');
  await page.locator('input[type=file]').setInputFiles({
    name: 'PRIVATE_UPLOAD_FILENAME_SENTINEL.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('PRIVATE_UPLOAD_CONTENT_SENTINEL'),
  });
  const selected = await snapshot(page);
  expect(JSON.stringify(selected)).not.toContain('PRIVATE_UPLOAD');
  expect(
    selected.fields.find((field) => field.control_type === 'file')
      ?.current_value,
  ).toBeNull();
  await page.evaluate(() => {
    document.body.innerHTML = '<form></form>';
    const form = document.querySelector('form')!;
    for (let i = 0; i < 260; i++) {
      const input = document.createElement('input');
      input.name = 'bounded_' + i;
      form.append(input);
    }
  });
  const limited = await snapshot(page);
  expect(limited.fields).toHaveLength(250);
  expect(limited.complete).toBe(false);
  expect(limited.warnings).toContainEqual({ code: 'FIELD_LIMIT', count: 10 });
  const expired = await page.evaluate(async () => {
    window.__m2Scanner.session.expires_at = Date.now() - 1;
    try {
      await window.__m2Scanner.read();
      return 'unexpected-success';
    } catch (error) {
      return (error as Error).message;
    }
  });
  expect(expired).toBe('SNAPSHOT_EXPIRED');
});
test('同名 radio 按 form 隔离，重复选项值需要人工核对', async ({ page }) => {
  await initialize(page, 'basic.html');
  await page.evaluate(() => {
    document.body.innerHTML =
      '<form><fieldset><legend>第一组</legend><label><input type="radio" name="repeated">选项甲</label><label><input type="radio" name="repeated">选项乙</label></fieldset></form><form><fieldset><legend>第二组</legend><label><input type="radio" name="repeated" value="x">选项丙</label><label><input type="radio" name="repeated" value="y">选项丁</label></fieldset></form>';
  });
  const s = await snapshot(page);
  expect(s.fields).toHaveLength(2);
  expect(s.fields[0]!.form_id).not.toBe(s.fields[1]!.form_id);
  expect(s.fields[0]!).toMatchObject({
    manual_reason: 'AMBIGUOUS_OPTIONS',
    supported: false,
  });
  expect(s.fields[1]!.supported).toBe(true);
});
