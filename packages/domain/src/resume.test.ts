import { it, expect } from 'vitest';
import {
  profileFact,
  qualifiedProfile,
  reviewedJob,
} from '../../../tests/fixtures/career';
import {
  syntheticProfile,
  nameExtraction,
} from '../../../tests/fixtures/resumes/synthetic';
import { emptyProfile, importExtraction, reviseFact } from './index';
import {
  createResumeVariant,
  exportResume,
  isResumeCurrent,
  putResumeVariant,
  reviseResumeVariant,
  validateResumeGrounding,
  validateResumeVariant,
} from './resume';
import { emptyCareer, putCareerJob, reviseJob } from './career';
const simpleJob = () =>
  reviewedJob([{ kind: 'skill', quote: '熟练掌握Java。', term: 'Java' }]);

it('只收录已确认且无冲突事实，正文与原始资料保持原值', async () => {
  const job = await simpleJob();
  let p = profileFact(
    qualifiedProfile(),
    'project.name',
    '待确认项目',
    null,
    false,
  ).profile;
  p = profileFact(p, 'basic.name', '合成同学').profile;
  const before = structuredClone(p),
    resume = await createResumeVariant(job, p, 'Java 岗位');
  expect(resume.status).toBe('draft');
  expect(
    resume.blocks.flatMap((b) => b.facts).some((f) => f.value === '待确认项目'),
  ).toBe(false);
  expect(p).toEqual(before);
  expect(() => exportResume(resume, job, p, 'markdown')).toThrow('先审核');
  const approved = reviseResumeVariant(resume, { approve: true }, job, p);
  const text = exportResume(approved, job, p, 'markdown');
  expect(text).toContain('合成同学');
  expect(text).not.toContain('待确认项目');
  expect(text).not.toContain('匹配证据');
  expect(text).not.toContain('提升');
});
it('相关项目按 JD 前移，同一经历不混用；JavaScript 不作 Java 线索', async () => {
  const job = await simpleJob();
  let p = profileFact(emptyProfile(), 'project.name', '前端项目');
  p = profileFact(
    p.profile,
    'project.description',
    '使用 JavaScript 构建页面',
    p.entity_id,
  );
  const unrelated = p.entity_id;
  p = profileFact(p.profile, 'project.name', '接口项目');
  p = profileFact(
    p.profile,
    'project.description',
    '使用 Java 构建接口',
    p.entity_id,
  );
  const related = p.entity_id;
  const resume = await createResumeVariant(job, p.profile, '后端');
  expect(resume.blocks[0]?.entity_id).toBe(related);
  expect(resume.selected_fact_ids).toEqual(
    resume.blocks
      .find((b) => b.entity_id === related)!
      .facts.map((f) => f.fact_id),
  );
  expect(
    resume.blocks
      .find((b) => b.entity_id === unrelated)!
      .facts.flatMap((f) => f.relevance),
  ).toEqual([]);
  expect(
    resume.blocks
      .find((b) => b.entity_id === related)!
      .facts.flatMap((f) => f.relevance),
  ).toEqual([
    { requirement_id: job.requirements[0]!.requirement_id, kind: 'related' },
  ]);

  expect(
    resume.blocks.every((b) =>
      b.facts.every((f) => f.entity_id === b.entity_id),
    ),
  ).toBe(true);
});
it('保留日期精度，默认不选入性别、证书编号和薪资', async () => {
  const job = await simpleJob();
  let p = profileFact(qualifiedProfile(), 'basic.gender', '合成性别');
  p = profileFact(p.profile, 'certificate.number', 'PRIVATE_CERT_SENTINEL');
  p = profileFact(p.profile, 'intention.salary', '30000');
  p = profileFact(p.profile, 'education.start_date', {
    value: '2020-09',
    precision: 'month',
  });
  const draft = await createResumeVariant(job, p.profile, '日期精度');
  const approved = reviseResumeVariant(
    draft,
    { approve: true },
    job,
    p.profile,
  );
  const text = exportResume(approved, job, p.profile, 'markdown');
  expect(text).toContain('2020\\-09');
  expect(text).not.toContain('2020\\-09\\-01');
  expect(text).not.toContain('PRIVATE_CERT_SENTINEL');
  expect(text).not.toContain('30000');
  expect(text).not.toContain('合成性别');
});
it('删除选入事实后不会经标题或预览泄露，排序与修改历史可恢复但不恢复审核', async () => {
  const job = await simpleJob(),
    p = qualifiedProfile(),
    first = await createResumeVariant(job, p, '初稿');
  const approved = reviseResumeVariant(first, { approve: true }, job, p);
  const hidden = approved.blocks
    .flatMap((b) => b.facts)
    .find((f) => f.path === 'skill.name')!;
  const edited = reviseResumeVariant(
    approved,
    {
      name: '精简版',
      selected_fact_ids: approved.selected_fact_ids.filter(
        (id) => id !== hidden.fact_id,
      ),
      block_order: [...approved.block_order].reverse(),
    },
    job,
    p,
  );
  expect(edited.status).toBe('draft');
  expect(edited.approved_at).toBeNull();
  expect(edited.change_note).toContain('移除 1 条');
  expect(edited.change_note).toContain('调整经历顺序');
  expect(() => exportResume(edited, job, p, 'html')).toThrow('先审核');
  const restored = reviseResumeVariant(
    edited,
    { restore_revision: approved.revision },
    job,
    p,
  );
  expect(restored.selected_fact_ids).toEqual(approved.selected_fact_ids);
  expect(restored.block_order).toEqual(approved.block_order);
  expect(restored.status).toBe('draft');
  expect(restored.revision).toBe(edited.revision + 1);
});
it('拒绝未知事实、重复或漏失分组、空正文和与审核混合的修订', async () => {
  const job = await simpleJob(),
    p = qualifiedProfile(),
    resume = await createResumeVariant(job, p, '校验');
  for (const change of [
    { selected_fact_ids: ['unknown'] },
    { selected_fact_ids: [] },
    { block_order: [] },
    { block_order: resume.block_order.map(() => resume.block_order[0]!) },
    { name: '' },
    { name: 'new', approve: true },
  ]) {
    expect(() => reviseResumeVariant(resume, change, job, p)).toThrow();
  }
  const forged = structuredClone(resume);
  forged.blocks[0]!.facts[0]!.entity_id = 'other';
  expect(() => validateResumeVariant(forged)).toThrow('实体');
});
it('资料、JD、日期和规则变化阻止旧审核导出，原快照不被回写', async () => {
  const job = await simpleJob(),
    p = qualifiedProfile(),
    draft = await createResumeVariant(job, p, '版本');
  const approved = reviseResumeVariant(draft, { approve: true }, job, p);
  const edited = reviseFact(p, p.facts[0]!.fact_id, { value: '硕士' });
  expect(isResumeCurrent(approved, job, edited)).toBe(false);
  expect(() => exportResume(approved, job, edited, 'html')).toThrow(
    '资料已变化',
  );
  expect(() =>
    reviseResumeVariant(
      approved,
      { approve: true },
      reviseJob(job, { confirm_all: true }),
      p,
    ),
  ).toThrow('岗位或资料已变化');
  expect(isResumeCurrent(approved, job, p, '2099-01-01')).toBe(false);
  expect(isResumeCurrent({ ...approved, engine_version: 'old' }, job, p)).toBe(
    false,
  );
  validateResumeGrounding(approved, edited); // old confirmed fact versions remain auditable
  expect(() => validateResumeGrounding(approved, edited, true)).toThrow(
    '已确认事实不一致',
  );
});
it('新版本独立绑定最新资料，不能借用另一个岗位或覆盖事实快照', async () => {
  const job = await simpleJob(),
    p = qualifiedProfile(),
    first = await createResumeVariant(job, p, '原版');
  let state = putResumeVariant(putCareerJob(emptyCareer(), job), first);
  const next = await createResumeVariant(job, p, '新版', first);
  state = putResumeVariant(state, next);
  expect(state.resumes).toHaveLength(2);
  expect(next.based_on_resume_id).toBe(first.resume_id);
  expect(() => putResumeVariant(state, first)).toThrow('修订已变化');
  const approved = reviseResumeVariant(first, { approve: true }, job, p);
  const forged = structuredClone(approved);
  forged.blocks[0]!.facts[0]!.value = '编造业绩';
  expect(() => putResumeVariant(state, forged, first.revision)).toThrow(
    '事实来源快照',
  );
  expect(() => putResumeVariant(state, approved, first.revision + 1)).toThrow(
    '修订已变化',
  );
  await expect(
    createResumeVariant(await simpleJob(), p, '另一岗位', first),
  ).rejects.toThrow('另一个岗位');
});
it('材料事实携带原文引用，篡改值、证据或事实版本不能通过保存校验', async () => {
  let p = syntheticProfile();
  p = importExtraction(
    p,
    p.documents[0]!.document_id,
    nameExtraction(p.documents[0]!),
  );
  p = reviseFact(p, p.facts[0]!.fact_id, { confirmation: 'confirmed' });
  const job = await simpleJob(),
    resume = await createResumeVariant(job, p, '证据');
  expect(resume.blocks[0]!.facts[0]!.evidences[0]!.quote).toBe(
    '姓名：测试同学',
  );
  validateResumeGrounding(resume, p, true);
  const forged = structuredClone(resume);
  forged.blocks[0]!.facts[0]!.value = '虚构';
  expect(() => validateResumeGrounding(forged, p)).toThrow('事实不一致');
  const forgedQuote = structuredClone(resume);
  forgedQuote.blocks[0]!.facts[0]!.evidences[0]!.quote = '姓名：另一同学';
  expect(() => validateResumeGrounding(forgedQuote, p)).toThrow('证据已失效');
});
it('HTML 与 Markdown 导出只输出纯文本值，排除脚本、远程资源和链接执行', async () => {
  const job = await simpleJob(),
    p = profileFact(
      qualifiedProfile(),
      'project.description',
      '<script>alert(1)</script>\n![image](https://evil.test/a)\n<a href="javascript:x">x</a>',
    ).profile;
  const draft = await createResumeVariant(job, p, '导出安全');
  const approved = reviseResumeVariant(draft, { approve: true }, job, p);
  const h = exportResume(approved, job, p, 'html'),
    md = exportResume(approved, job, p, 'markdown');
  expect(h).toContain('Content-Security-Policy');
  expect(h).toContain('&lt;script&gt;');
  expect(h).not.toContain('<script>');
  expect(h).not.toContain('<a href=');
  expect(h).not.toContain('<img');
  expect(md).not.toContain('<script>');
  expect(md).not.toContain('![image](');
  expect(h).not.toContain('requirement_id');
});
it('岗位简历数量与历史有界，未审阅岗位与无确认资料不能生成', async () => {
  const job = await simpleJob(),
    p = qualifiedProfile();
  await expect(
    createResumeVariant({ ...job, reviewed: false }, p, '无审核'),
  ).rejects.toThrow('核对');
  await expect(
    createResumeVariant(job, emptyProfile(), '无资料'),
  ).rejects.toThrow('确认个人事实');
  let resume = await createResumeVariant(job, p, '历史');
  for (let i = 0; i < 12; i++)
    resume = reviseResumeVariant(resume, { name: '版本' + i }, job, p);
  expect(resume.history).toHaveLength(10);
  const state = putCareerJob(emptyCareer(), job);
  state.resumes = Array.from({ length: 20 }, () => ({
    ...resume,
    resume_id: crypto.randomUUID(),
  }));
  await expect(
    Promise.resolve().then(async () =>
      putResumeVariant(state, await createResumeVariant(job, p, '超额')),
    ),
  ).rejects.toThrow('20');
});

it('冲突、拒绝和待确认的事实不进入简历来源快照', async () => {
  let p = profileFact(qualifiedProfile(), 'basic.name', '冲突旧名');
  p = profileFact(p.profile, 'basic.name', '冲突新名', p.entity_id, false);
  const skill = p.profile.facts.find((f) => f.path === 'skill.name')!;
  const profile = reviseFact(p.profile, skill.fact_id, {
    confirmation: 'rejected',
  });
  const resume = await createResumeVariant(
    await simpleJob(),
    profile,
    '排除冲突',
  );
  const facts = resume.blocks.flatMap((b) => b.facts);
  expect(facts.some((f) => f.path === 'basic.name')).toBe(false);
  expect(facts.some((f) => f.path === 'skill.name')).toBe(false);
});

it('根据最新资料生成独立版本时保留已排除内容和经历顺序', async () => {
  const job = await simpleJob(),
    p = qualifiedProfile();
  const first = await createResumeVariant(job, p, '原版');
  const skill = first.blocks
    .flatMap((b) => b.facts)
    .find((f) => f.path === 'skill.name')!;
  const edited = reviseResumeVariant(
    first,
    {
      selected_fact_ids: first.selected_fact_ids.filter(
        (id) => id !== skill.fact_id,
      ),
      block_order: [...first.block_order].reverse(),
    },
    job,
    p,
  );
  const newer = profileFact(p, 'project.name', '新增合成项目').profile;
  const next = await createResumeVariant(job, newer, '新版', edited);
  expect(next.selected_fact_ids).not.toContain(skill.fact_id);
  expect(
    next.blocks.slice(0, edited.blocks.length).map((b) => b.entity_id),
  ).toEqual(
    edited.block_order.map(
      (id) => edited.blocks.find((b) => b.block_id === id)!.entity_id,
    ),
  );
  expect(
    next.blocks.flatMap((b) => b.facts).some((f) => f.value === '新增合成项目'),
  ).toBe(true);
  expect(edited.profile_revision).toBe(p.profile_revision);
});
