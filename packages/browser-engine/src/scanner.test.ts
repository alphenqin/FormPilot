import { it, expect } from 'vitest';
import { safeRoute, structuralProjection, siteProfile } from './index';
import type { ScannedField, ScanGroup } from '@formpilot/contracts';
const field: ScannedField = {
  field_id: 'field-1',
  locator_ref: 'locator-1',
  group_id: 'group-1',
  form_id: 'form-1',
  label: '姓名',
  label_source: 'label',
  manual_label: null,
  description: '',
  name: 'name',
  html_id: 'name',
  placeholder: '',
  control_type: 'text',
  required: true,
  visible: true,
  enabled: true,
  read_only: false,
  supported: true,
  manual_reason: null,
  current_value: '旧值',
  options: [],
  option_count: 0,
  constraints: {
    min: null,
    max: null,
    step: null,
    pattern: null,
    min_length: null,
    max_length: 30,
    accept: null,
    multiple: false,
  },
};
const groups: ScanGroup[] = [
  {
    group_id: 'group-1',
    form_id: 'form-1',
    label: '基本信息',
    parent_group_id: null,
  },
];
it('结构投影不包含当前值与人工标注，自身填值不会改变结构', () => {
  expect(structuralProjection([field], groups)).toEqual(
    structuralProjection(
      [{ ...field, current_value: '新值', manual_label: '联系电话' }],
      groups,
    ),
  );
  expect(JSON.stringify(structuralProjection([field], groups))).not.toContain(
    '旧值',
  );
});
it('类型、选项、约束、标签、分组和定位身份变化会改变结构', () => {
  const original = structuralProjection([field], groups);
  for (const change of [
    { control_type: 'select' },
    { label: '意向城市' },
    { required: false },
    { locator_ref: 'replacement' },
    { constraints: { ...field.constraints, max_length: 5 } },
    {
      options: [{ label: '本科', value: 'bachelor', disabled: false }],
      option_count: 1,
    },
  ])
    expect(structuralProjection([{ ...field, ...change }], groups)).not.toEqual(
      original,
    );
  expect(
    structuralProjection([field], [{ ...groups[0]!, label: '工作经历' }]),
  ).not.toEqual(original);
});
it('路由去除查询参数、普通 hash 和高熵/邮箱路径段', () => {
  const route = safeRoute(
    'https://example.test/apply/user%40example.test/abcdef0123456789?token=URL_SECRET_SENTINEL#private=HASH_SECRET_SENTINEL',
  );
  expect(route).toBe('/apply/:private/:private');
  expect(route).not.toContain('SECRET');
  expect(safeRoute('https://example.test/#/apply/step2?token=SECRET')).toBe(
    '/#/apply/step2',
  );
});
it('只按精确官方 hostname 识别候选，不把仿冒域名当作已适配站点', () => {
  expect(siteProfile('careers.tencent.com').id).toBe('tencent');
  expect(siteProfile('jobs.bytedance.com').id).toBe('bytedance');
  expect(siteProfile('hr.xiaomi.com').id).toBe('xiaomi');
  expect(siteProfile('careers.tencent.com.attacker.test').id).toBe('generic');
  expect(siteProfile('careers.tencent.com').verification).toBe(
    'native-controls-only',
  );
});
