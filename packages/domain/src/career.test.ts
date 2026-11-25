import { it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  hashJson,
  JobMatchSchema,
  ParsedJobSchema,
  type JobModelOutput,
} from '@formpilot/contracts';
import {
  jobSource,
  reviewedJob,
  profileFact,
  workPeriod,
  qualifiedProfile,
} from '../../../tests/fixtures/career';
import {
  validateJobModel,
  acceptParsedJob,
  reviseJob,
  matchJob,
  requirementCriterion,
  emptyCareer,
  putCareerJob,
  putJobMatch,
  validateCareerState,
  sanitizeJobURL,
} from './career';
import { emptyProfile, reviseFact } from './index';
const meta = {
  provider: 'test',
  model: 'controlled',
  usage: { input_tokens: 1, output_tokens: 1 },
  duration_ms: 1,
};
it('JD 原文引用唯一、范围真实，模型不得自带批准、事实或评分', async () => {
  const source = jobSource(),
    value: JobModelOutput = {
      attributes: [
        { key: 'title', value: '后端工程师', quote: '职位：后端工程师' },
      ],
      requirements: [
        {
          kind: 'education',
          priority: 'core',
          term: null,
          quote: '本科及以上学历。',
        },
      ],
    };
  const parsed = await validateJobModel(source, value, meta);
  expect(Value.Check(ParsedJobSchema, parsed)).toBe(true);
  expect(parsed.requirements[0]?.confirmed).toBe(false);
  expect(parsed.requirements[0]?.priority).toBe('hard');
  expect(
    source.text.slice(
      parsed.requirements[0]!.start,
      parsed.requirements[0]!.end,
    ),
  ).toBe('本科及以上学历。');
  await expect(
    validateJobModel(source, { ...value, score: 100 }, meta),
  ).rejects.toThrow('MODEL_INVALID_OUTPUT');
  await expect(
    validateJobModel(
      source,
      {
        ...value,
        attributes: [
          { key: 'company', value: '不存在', quote: '公司：虚构科技' },
        ],
      },
      meta,
    ),
  ).rejects.toThrow('EVIDENCE_INVALID');
  await expect(
    validateJobModel(
      jobSource('Java\nJava'),
      {
        attributes: [],
        requirements: [
          { kind: 'skill', priority: 'hard', quote: 'Java', term: 'Java' },
        ],
      },
      meta,
    ),
  ).rejects.toThrow('EVIDENCE_INVALID');
});
it('解析必须先确认原文；修改分类再次待确认并递增版本，不能回退', async () => {
  const source = jobSource('熟练掌握Java。'),
    parsed = await validateJobModel(
      source,
      {
        attributes: [],
        requirements: [
          { kind: 'skill', priority: 'core', term: 'Java', quote: source.text },
        ],
      },
      meta,
    );
  const draft = await acceptParsedJob(source, parsed);
  await expect(matchJob(draft, qualifiedProfile())).rejects.toThrow('确认');
  const confirmed = reviseJob(draft, { confirm_all: true });
  expect(confirmed.reviewed).toBe(true);
  const changed = reviseJob(confirmed, {
    requirement: {
      ...confirmed.requirements[0]!,
      priority: 'preferred',
      confirmed: true,
    },
  });
  expect(changed.reviewed).toBe(false);
  expect(changed.requirements[0]?.confirmed).toBe(false);
  const state = putCareerJob(emptyCareer(), confirmed);
  expect(() => putCareerJob(state, draft, confirmed.revision)).toThrow(
    'REVISION_CONFLICT',
  );
  await expect(
    acceptParsedJob({ ...source, text: '其他文本' }, parsed),
  ).rejects.toThrow('EVIDENCE_INVALID');
});
it('明确学历、技能熟练度和意向地点由已确认事实匹配，保留证据引用', async () => {
  const job = await reviewedJob([
    { kind: 'education', quote: '本科及以上学历。' },
    { kind: 'skill', quote: '熟练掌握Java。', term: 'Java' },
    { kind: 'location', quote: '工作地点：北京', term: '北京' },
  ]);
  const result = await matchJob(job, qualifiedProfile(), '2026-11-17');
  expect(Value.Check(JobMatchSchema, result)).toBe(true);
  expect(result.rows.map((r) => r.status)).toEqual([
    'matched',
    'matched',
    'matched',
  ]);
  expect(result.rows.every((r) => r.fact_refs.length > 0)).toBe(true);
  expect(result.final_hiring_decision).toBe(false);
});
it('JavaScript 不等于 Java，描述关键词不等于结构化能力证据', async () => {
  const job = await reviewedJob([
    { kind: 'skill', quote: '熟练掌握Java。', term: 'Java' },
  ]);
  let p = profileFact(emptyProfile(), 'skill.name', 'JavaScript').profile;
  expect((await matchJob(job, p)).rows[0]?.status).not.toBe('matched');
  p = profileFact(
    emptyProfile(),
    'project.description',
    '学习Java示例，并未用于工作',
  ).profile;
  expect((await matchJob(job, p)).rows[0]?.status).toBe('insufficient');
});
it('技能名称与熟练度不能跨实体拼凑，未确认事实不参与', async () => {
  const job = await reviewedJob([
    { kind: 'skill', quote: '熟练掌握Java。', term: 'Java' },
  ]);
  let p = profileFact(emptyProfile(), 'skill.name', 'Java');
  p = profileFact(p.profile, 'skill.name', 'Python');
  p = profileFact(p.profile, 'skill.level', '熟练', p.entity_id);
  expect((await matchJob(job, p.profile)).rows[0]?.status).toBe('insufficient');
  const pending = profileFact(
    emptyProfile(),
    'skill.name',
    'Java',
    null,
    false,
  ).profile;
  expect((await matchJob(job, pending)).rows[0]?.status).toBe(
    'needs_confirmation',
  );
});
it('现居地不当作求职意向，也不从不同意向推断不愿搬迁', async () => {
  const job = await reviewedJob([
    { kind: 'location', quote: '工作地点：北京', term: '北京' },
  ]);
  let p = profileFact(emptyProfile(), 'basic.current_city', '北京').profile;
  expect((await matchJob(job, p)).rows[0]?.status).toBe('needs_confirmation');
  p = profileFact(p, 'intention.city', '杭州').profile;
  expect((await matchJob(job, p)).rows[0]?.status).toBe('insufficient');
});
it('较低学历和明确不掌握技能分别不匹配，缺少资料不直接判不具备', async () => {
  const job = await reviewedJob([
    { kind: 'education', quote: '硕士及以上学历。' },
    { kind: 'skill', quote: '熟悉Java。', term: 'Java' },
  ]);
  let p = profileFact(emptyProfile(), 'education.degree', '本科');
  p = profileFact(p.profile, 'skill.name', 'Java');
  p = profileFact(p.profile, 'skill.level', '不掌握', p.entity_id);
  expect((await matchJob(job, p.profile)).rows.map((r) => r.status)).toEqual([
    'unmatched',
    'unmatched',
  ]);
  expect(
    (await matchJob(job, emptyProfile())).rows.every(
      (r) => r.status === 'needs_confirmation',
    ),
  ).toBe(true);
});
it('多个条件、范围、相关专业、全日制与额外技能限制不被遗漏后判匹配', () => {
  for (const [kind, quote, term] of [
    ['education', '本科及以上，熟悉Java', 'Java'],
    ['education', '全日制本科及以上', null],
    ['experience', '至少3年Java工作经验', null],
    ['experience', '3-5年工作经验', null],
    ['skill', '熟悉Java和Python', 'Java'],
    ['skill', '熟练Java，并能独立设计系统', 'Java'],
    ['major', '计算机相关专业', '计算机'],
    ['location', '工作地点北京，可远程', '北京'],
  ] as const)
    expect(requirementCriterion(kind, quote, term).type, quote).toBe('unknown');
});
it('学历识别不因 Masterpiece 之类字符串片段误判', async () => {
  const job = await reviewedJob([
      { kind: 'education', quote: '硕士及以上学历。' },
    ]),
    p = profileFact(emptyProfile(), 'education.degree', 'Masterpiece').profile;
  expect((await matchJob(job, p)).rows[0]?.status).not.toBe('matched');
});
it('年限合并重叠工作时间，不累计重复时长', async () => {
  const job = await reviewedJob([
    { kind: 'experience', quote: '至少3年工作经验。' },
  ]);
  let p = workPeriod(emptyProfile(), '2020-01-01', '2022-01-01');
  p = workPeriod(p, '2020-06-01', '2022-06-01');
  const out = await matchJob(job, p, '2026-11-17');
  expect(out.rows[0]?.status).toBe('unmatched');
  expect(out.rows[0]?.fact_refs).toHaveLength(4);
});
it('明确满足年限引用完整日期证据；实习和项目不当作工作', async () => {
  const job = await reviewedJob([
    { kind: 'experience', quote: '至少3年工作经验。' },
  ]);
  expect(
    (
      await matchJob(
        job,
        workPeriod(emptyProfile(), '2020-01-01', '2023-01-01'),
        '2026-11-17',
      )
    ).rows[0]?.status,
  ).toBe('matched');
  const internships = workPeriod(
    emptyProfile(),
    '2015-01-01',
    '2025-01-01',
    null,
    'internship',
  );
  expect((await matchJob(job, internships, '2026-11-17')).rows[0]?.status).toBe(
    'needs_confirmation',
  );
});
it('年月精度跨年限阈值、缺项和未来日期显示证据不足', async () => {
  const job = await reviewedJob([
    { kind: 'experience', quote: '至少3年工作经验。' },
  ]);
  for (const p of [
    workPeriod(emptyProfile(), '2020', '2023'),
    workPeriod(emptyProfile(), '2020-01-01', '2028-01-01'),
    profileFact(emptyProfile(), 'work.start_date', {
      value: '2020-01',
      precision: 'month',
    }).profile,
  ])
    expect((await matchJob(job, p, '2026-11-17')).rows[0]?.status).toBe(
      'insufficient',
    );
});
it('专业与学历不能借用不同教育经历拼凑', async () => {
  const job = await reviewedJob([
    { kind: 'education', quote: '硕士及以上学历。' },
    { kind: 'major', quote: '软件工程专业', term: '软件工程' },
  ]);
  let p = profileFact(emptyProfile(), 'education.degree', '本科');
  p = profileFact(p.profile, 'education.major', '软件工程', p.entity_id);
  p = profileFact(p.profile, 'education.degree', '博士');
  p = profileFact(p.profile, 'education.major', '其他专业', p.entity_id);
  expect((await matchJob(job, p.profile)).rows.map((r) => r.status)).toEqual([
    'matched',
    'insufficient',
  ]);
});
it('事实或岗位修订后旧结果有独立版本引用；删除岗位不留下分析孤儿', async () => {
  const job = await reviewedJob([
      { kind: 'education', quote: '本科及以上学历。' },
    ]),
    p = qualifiedProfile(),
    analysis = await matchJob(job, p);
  let state = putCareerJob(emptyCareer(), job);
  state = putJobMatch(state, analysis);
  expect(analysis.profile_revision).toBe(p.profile_revision);
  const edited = reviseFact(p, p.facts[0]!.fact_id, {
    confirmation: 'rejected',
  });
  expect(edited.profile_revision).not.toBe(analysis.profile_revision);
  const next = reviseJob(job, { confirm_all: true });
  state = putCareerJob(state, next, job.revision);
  expect(() => putJobMatch(state, analysis)).toThrow('REVISION_CONFLICT');
  validateCareerState(state);
  expect(() => validateCareerState({ ...state, jobs: [] })).toThrow(
    '岗位分析引用无效',
  );
});
it('备份验证拒绝伪造原文、条件和模型值；来源 URL 清除令牌', async () => {
  const job = await reviewedJob([
      { kind: 'skill', quote: '熟悉Java。', term: 'Java' },
    ]),
    state = putCareerJob(emptyCareer(), job);
  const forged = structuredClone(state);
  forged.jobs[0]!.requirements[0]!.criterion.value = 'Python';
  expect(() => validateCareerState(forged)).toThrow('岗位条件与原文不一致');
  expect(sanitizeJobURL('https://example.test/job?id=TOKEN#secret')).toBe(
    'https://example.test/job',
  );
  await expect(
    validateJobModel(
      jobSource('熟悉Java。'),
      {
        attributes: [],
        requirements: [
          {
            kind: 'skill',
            priority: 'hard',
            quote: '熟悉Java。',
            term: 'Python',
          },
        ],
      },
      meta,
    ),
  ).rejects.toThrow('EVIDENCE_INVALID');
  expect(await hashJson(job.source)).toBe(job.source_hash);
});
