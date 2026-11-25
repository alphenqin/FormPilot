import { it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  buildFillPlan,
  newPlanningContext,
  resolveContext,
  validateModelMappings,
  validatePlanningInput,
} from './planning';
import {
  FillPlanSchema,
  hashJson,
  digestiblePlan,
  type FillPlanRequest,
  type ResolveRequest,
} from '@formpilot/contracts';
import { planningRequest, field, fact } from '../../../tests/fixtures/planning';
async function plan(input: FillPlanRequest) {
  const ctx = newPlanningContext(input, { mappings: [] });
  const p = await buildFillPlan(ctx, {
    plan_id: 'plan-1',
    plan_revision: 1,
    expires_at: Date.now() + 60000,
    usage: { input_tokens: 0, output_tokens: 0 },
    duration_ms: 0,
  });
  expect(Value.Check(FillPlanSchema, p)).toBe(true);
  return { ctx, p };
}
const changes = (
  answers: ResolveRequest['answers'] = [],
  resolutions: ResolveRequest['resolutions'] = [],
): ResolveRequest => ({
  schema_version: 1,
  client_request_id: crypto.randomUUID(),
  task_id: 'task-1',
  plan_id: 'plan-1',
  expected_plan_revision: 1,
  answers,
  resolutions,
});
it('现居城市与意向城市分开，重复缺项只提问一次，答案仅属于任务', async () => {
  const r = await planningRequest(
    [
      field('现居城市'),
      field('意向城市', 'field-2'),
      field('期望城市', 'field-3'),
    ],
    [fact('basic.current_city', '杭州')],
  );
  const { ctx, p } = await plan(r);
  expect(p.field_decisions.map((d) => d.decision)).toEqual([
    'fill',
    'ask',
    'ask',
  ]);
  expect(p.questions).toHaveLength(1);
  expect(p.questions[0]!.field_ids).toHaveLength(2);
  const resolved = resolveContext(
    ctx,
    p,
    changes([
      {
        question_id: p.questions[0]!.question_id,
        value: '深圳',
        precision: null,
        scope: 'task',
      },
    ]),
  );
  const out = await buildFillPlan(resolved, {
    plan_id: 'plan-2',
    plan_revision: 2,
    expires_at: p.expires_at,
    usage: p.usage,
    duration_ms: 0,
  });
  expect(out.field_decisions.map((d) => d.target_value)).toEqual([
    '杭州',
    '深圳',
    '深圳',
  ]);
  expect(out.task_answers[0]?.scope).toBe('task');
  expect(r.confirmed_facts).toHaveLength(1);
});
it('年月不补日；正确精度的任务补答才可填入 date', async () => {
  const r = await planningRequest(
    [field('开始时间', 'field-1', { control_type: 'date' })],
    [
      fact(
        'education.start_date',
        { value: '2020-09', precision: 'month' },
        'edu-1',
      ),
    ],
  );
  r.form_snapshot.groups[0]!.label = '教育经历';
  const { ctx, p } = await plan(r);
  expect(p.field_decisions[0]?.decision).toBe('ask');
  expect(p.field_decisions[0]?.target_value).toBeNull();
  const next = resolveContext(
    ctx,
    p,
    changes([
      {
        question_id: p.questions[0]!.question_id,
        value: '2020-09-12',
        precision: 'day',
        scope: 'task',
      },
    ]),
  );
  expect(next.answers[0]?.precision).toBe('day');
});
it('原值冲突明确替换才 fill，保留或取消均 skip', async () => {
  const { ctx, p } = await plan(
    await planningRequest([
      field('姓名', 'field-1', { current_value: '网页旧值' }),
    ]),
  );
  expect(p.field_decisions[0]?.reason_code).toBe('CURRENT_VALUE_CONFLICT');
  for (const type of ['keep', 'cancel', 'replace'] as const) {
    const next = resolveContext(
      ctx,
      p,
      changes([], [{ type, field_id: 'field-1' }]),
    );
    const out = await buildFillPlan(next, {
      plan_id: 'plan-2',
      plan_revision: 2,
      expires_at: p.expires_at,
      usage: p.usage,
      duration_ms: 0,
    });
    expect(out.field_decisions[0]?.decision).toBe(
      type === 'replace' ? 'fill' : 'skip',
    );
  }
});
it('多段经历必须显式绑定，不以数组顺序混合', async () => {
  const r = await planningRequest(
    [field('公司名称'), field('职位', 'field-2')],
    [
      fact('internship.company', '甲公司', 'i1'),
      fact('internship.position', '甲职位', 'i1'),
      fact('internship.company', '乙公司', 'i2'),
      fact('internship.position', '乙职位', 'i2'),
    ],
  );
  r.form_snapshot.groups[0]!.label = '实习经历';
  const { ctx, p } = await plan(r);
  expect(p.questions).toHaveLength(1);
  expect(p.field_decisions.every((d) => d.decision === 'review')).toBe(true);
  const next = resolveContext(
    ctx,
    p,
    changes([
      {
        question_id: p.questions[0]!.question_id,
        value: 'i2',
        precision: null,
        scope: 'task',
      },
    ]),
  );
  const out = await buildFillPlan(next, {
    plan_id: 'plan-2',
    plan_revision: 2,
    expires_at: p.expires_at,
    usage: p.usage,
    duration_ms: 0,
  });
  expect(out.field_decisions.map((d) => d.target_value)).toEqual([
    '乙公司',
    '乙职位',
  ]);
  expect(out.entity_bindings[0]?.source).toBe('user');
});
it('允许本任务新增经历，但不把新经历写入资料库', async () => {
  const r = await planningRequest([field('公司名称')], []);
  r.form_snapshot.groups[0]!.label = '实习经历';
  const { ctx, p } = await plan(r);
  const next = resolveContext(
    ctx,
    p,
    changes([
      {
        question_id: p.questions[0]!.question_id,
        value: 'new-task-entity',
        precision: null,
        scope: 'task',
      },
    ]),
  );
  expect(next.task_entities).toHaveLength(1);
  expect(r.entities).toHaveLength(0);
});
it('同组时间倒置 review；跨经历时间重叠允许', async () => {
  const r = await planningRequest(
    [field('开始时间'), field('结束时间', 'field-2')],
    [
      fact(
        'project.start_date',
        { value: '2024-05', precision: 'month' },
        'p1',
      ),
      fact('project.end_date', { value: '2024-01', precision: 'month' }, 'p1'),
    ],
  );
  r.form_snapshot.groups[0]!.label = '项目经历';
  const { p } = await plan(r);
  expect(
    p.field_decisions.every((d) => d.reason_code === 'TIME_RANGE_ERROR'),
  ).toBe(true);
});
it('选项使用网页 value，存在同名歧义时不猜测', async () => {
  const r = await planningRequest(
    [
      field('性别', 'field-1', {
        control_type: 'select',
        options: [{ value: 'M', label: '男', disabled: false }],
        option_count: 1,
      }),
    ],
    [fact('basic.gender', '男')],
  );
  expect((await plan(r)).p.field_decisions[0]?.target_value).toBe('M');
  r.form_snapshot.fields[0]!.options.push({
    value: 'male',
    label: '男',
    disabled: false,
  });
  expect((await plan(r)).p.field_decisions[0]?.decision).toBe('review');
});
it('五类决策同时出现，敏感字段、条款与不支持控件不会生成可填值', async () => {
  const r = await planningRequest([
    field(),
    field('意向城市', 'field-2'),
    field('姓名', 'field-3', { current_value: '已有' }),
    field('附件', 'field-4', { control_type: 'file', supported: false }),
    field('身份证', 'field-5'),
    field('同意隐私条款', 'field-6', {
      control_type: 'checkbox',
      current_value: false,
    }),
  ]);
  const { p } = await plan(r);
  expect(p.field_decisions.map((d) => d.decision)).toEqual([
    'fill',
    'ask',
    'review',
    'manual',
    'skip',
    'manual',
  ]);
});
it('非法字段、实体、引用、模型附加值以及循环分组被拒绝', async () => {
  const r = await planningRequest();
  for (const value of [
    {
      mappings: [{ field_id: 'invented', path: 'basic.name', entity_id: null }],
    },
    {
      mappings: [
        { field_id: 'field-1', path: 'basic.name', entity_id: 'unknown' },
      ],
    },
    { mappings: [], value: '模型虚构' },
  ])
    expect(() => validateModelMappings(r, value)).toThrow(
      'MODEL_INVALID_OUTPUT',
    );
  r.form_snapshot.groups[0]!.parent_group_id = 'group-1';
  expect(() => validatePlanningInput(r)).toThrow('RULE_VIOLATION');
});
it('坏模型降级只能 review 事实，任务手动输入可恢复；摘要校验可重算', async () => {
  const r = await planningRequest(),
    ctx = newPlanningContext(r, { mappings: [] }, 'MODEL_TIMEOUT');
  const p = await buildFillPlan(ctx, {
    plan_id: 'p1',
    plan_revision: 1,
    expires_at: Date.now() + 60000,
    usage: { input_tokens: 0, output_tokens: 0 },
    duration_ms: 3,
  });
  expect(p.field_decisions[0]?.decision).toBe('review');
  expect(p.degraded).toBe(true);
  expect(p.plan_digest).toBe(await hashJson(digestiblePlan(p)));
  expect(() =>
    resolveContext(
      ctx,
      p,
      changes([
        {
          question_id: 'invented',
          value: '虚构',
          precision: null,
          scope: 'task',
        },
      ]),
    ),
  ).toThrow('REFERENCE_NOT_FOUND');
});
it('同一实体事实冲突与未知正则约束转审核', async () => {
  const r = await planningRequest(
    [field()],
    [fact(), fact('basic.name', '另一个名字')],
  );
  expect((await plan(r)).p.field_decisions[0]?.reason_code).toBe(
    'FACT_CONFLICT',
  );
  r.confirmed_facts.pop();
  r.form_snapshot.fields[0]!.constraints.pattern = '(a+)+$';
  expect((await plan(r)).p.field_decisions[0]?.reason_code).toBe(
    'PATTERN_REQUIRES_REVIEW',
  );
});
it('模型不能把意向城市改成现居城市，也不能直接提供填值', async () => {
  const r = await planningRequest(
    [field('意向城市')],
    [fact('basic.current_city', '杭州')],
  );
  const ctx = newPlanningContext(r, {
    mappings: [
      { field_id: 'field-1', path: 'basic.current_city', entity_id: 'basic-1' },
    ],
  });
  const p = await buildFillPlan(ctx, {
    plan_id: 'p1',
    plan_revision: 1,
    expires_at: Date.now() + 60000,
    usage: { input_tokens: 0, output_tokens: 0 },
    duration_ms: 0,
  });
  expect(p.field_decisions[0]?.reason_code).toBe('SEMANTIC_CONFLICT');
  expect(p.field_decisions[0]?.target_value).toBeNull();
});
it('原文事实需要有效证据，文字值必须出现在引用内', async () => {
  const r = await planningRequest();
  const f = r.confirmed_facts[0]!;
  f.source_type = 'resume';
  f.document_id = 'doc-1';
  f.evidence_ids = ['e-1'];
  r.evidences = [
    {
      evidence_id: 'e-1',
      document_id: 'doc-1',
      document_revision: 1,
      block_id: 'block-1',
      page: 1,
      quote: '姓名：PLAN_PRIVATE_SENTINEL',
      start: 0,
      end: 26,
    },
  ];
  r.evidences[0]!.end = r.evidences[0]!.quote.length;
  expect((await plan(r)).p.field_decisions[0]?.evidence_ids).toEqual(['e-1']);
  f.value = '伪造姓名';
  expect(() => validatePlanningInput(r)).toThrow('EVIDENCE_INVALID');
});
it('不同经历的合理时间重叠不判错，嵌套分组仍绑定到对应经历', async () => {
  const r = await planningRequest(
    [
      field('开始时间'),
      field('结束时间', 'f2'),
      field('开始时间', 'f3', { group_id: 'child-2' }),
      field('结束时间', 'f4', { group_id: 'child-2' }),
    ],
    [
      fact(
        'project.start_date',
        { value: '2024-01', precision: 'month' },
        'p1',
      ),
      fact('project.end_date', { value: '2024-07', precision: 'month' }, 'p1'),
      fact(
        'project.start_date',
        { value: '2024-03', precision: 'month' },
        'p2',
      ),
      fact('project.end_date', { value: '2024-08', precision: 'month' }, 'p2'),
    ],
  );
  r.form_snapshot.groups = [
    {
      group_id: 'group-1',
      form_id: 'form-1',
      parent_group_id: null,
      label: '项目 p1',
    },
    {
      group_id: 'group-2',
      form_id: 'form-1',
      parent_group_id: null,
      label: '项目 p2',
    },
    {
      group_id: 'child-2',
      form_id: 'form-1',
      parent_group_id: 'group-2',
      label: '时间',
    },
  ];
  const { p } = await plan(r);
  expect(p.field_decisions.every((d) => d.decision === 'fill')).toBe(true);
  expect(p.field_decisions.map((d) => d.entity_id)).toEqual([
    'p1',
    'p1',
    'p2',
    'p2',
  ]);
});
it('数字范围和步长约束不能被任务补答绕过', async () => {
  const r = await planningRequest(
    [
      field('期望薪资', 'field-1', {
        control_type: 'number',
        constraints: {
          ...field().constraints,
          min: '1000',
          max: '10000',
          step: '1000',
        },
      }),
    ],
    [fact('intention.salary', '12000', 'intent-1')],
  );
  expect((await plan(r)).p.field_decisions[0]?.reason_code).toBe(
    'RANGE_CONSTRAINT',
  );
  r.confirmed_facts[0]!.value = '1500';
  expect((await plan(r)).p.field_decisions[0]?.reason_code).toBe(
    'STEP_CONSTRAINT',
  );
});
