import { Value } from '@sinclair/typebox/value';
import {
  ResumeVariantSchema,
  canonicalJson,
  type CareerState,
  type JobDocument,
  type ResumeVariant,
  type ResumeBlock,
  type ResumeFact,
  type Category,
  type FactPath,
} from '@formpilot/contracts';
import {
  confirmedFacts,
  displayValue,
  validDate,
  validateFactValue,
  type ProfileState,
} from './index';
import { matchJob, MATCH_ENGINE_VERSION } from './career';

export const RESUME_ENGINE_VERSION = 'grounded-resume-0.1.0';
export const resumeCategoryNames: Record<Category, string> = {
  basic: '基本信息',
  intention: '求职意向',
  education: '教育经历',
  work: '工作经历',
  internship: '实习经历',
  project: '项目经历',
  skill: '专业技能',
  certificate: '证书',
};
export const resumeFactLabels: Record<FactPath, string> = {
  'basic.name': '姓名',
  'basic.gender': '性别',
  'basic.phone': '联系电话',
  'basic.email': '电子邮箱',
  'basic.current_city': '现居城市',
  'education.school': '学校',
  'education.major': '专业',
  'education.degree': '学历',
  'education.start_date': '入学时间',
  'education.end_date': '毕业时间',
  'work.company': '工作单位',
  'work.position': '工作职位',
  'work.department': '部门',
  'work.start_date': '工作开始时间',
  'work.end_date': '工作结束时间',
  'work.description': '工作内容',
  'internship.company': '实习单位',
  'internship.position': '实习岗位',
  'internship.start_date': '实习开始时间',
  'internship.end_date': '实习结束时间',
  'internship.description': '实习内容',
  'project.name': '项目名称',
  'project.role': '项目角色',
  'project.start_date': '项目开始时间',
  'project.end_date': '项目结束时间',
  'project.description': '项目描述',
  'skill.name': '技能',
  'skill.level': '熟练程度',
  'certificate.name': '证书名称',
  'certificate.date': '取得时间',
  'certificate.number': '证书编号',
  'intention.city': '意向城市',
  'intention.industry': '意向行业',
  'intention.position': '意向岗位',
  'intention.salary': '期望薪资',
};
const defaultHidden = new Set<FactPath>([
  'basic.gender',
  'certificate.number',
  'intention.salary',
]);
const categories: Category[] = [
  'basic',
  'intention',
  'education',
  'work',
  'internship',
  'project',
  'skill',
  'certificate',
];
const key = (v: string) => v.normalize('NFKC').trim().toLowerCase();
function containsTerm(value: string, term: string) {
  // Latin names use token boundaries: Java must not prioritize JavaScript.
  const text = key(value),
    word = key(term),
    pos = text.indexOf(word);
  if (!word || pos < 0) return false;
  if (/^[a-z0-9+#. -]+$/.test(word)) {
    let at = pos;
    while (at >= 0) {
      const before = text[at - 1] ?? '',
        after = text[at + word.length] ?? '';
      if (!/[a-z0-9_+#]/.test(before) && !/[a-z0-9_+#]/.test(after))
        return true;
      at = text.indexOf(word, at + 1);
    }
    return false;
  }
  return true;
}
function fail(message: string): never {
  throw new Error(message);
}
function nameOf(name: string) {
  const v = name.trim();
  if (!v || v.length > 160 || Array.from(v).some((c) => c.charCodeAt(0) < 32))
    fail('简历版本名称应为 1～160 个字符');
  return v;
}
export async function createResumeVariant(
  job: JobDocument,
  profile: ProfileState,
  name: string,
  basedOn: ResumeVariant | null = null,
): Promise<ResumeVariant> {
  if (!job.reviewed) fail('请先核对并确认岗位要求');
  if (basedOn && basedOn.job_id !== job.job_id)
    fail('不能将另一个岗位的简历作为刷新来源');
  const facts = confirmedFacts(profile);
  if (!facts.length) fail('请先添加并确认个人事实');
  if (facts.length > 400)
    fail('已确认事实超过 400 条，请先整理资料后再生成简历');
  const analysis = await matchJob(job, profile),
    blocks: ResumeBlock[] = [];
  for (const fact of facts) {
    const relevance: ResumeFact['relevance'] = [];
    for (const r of job.requirements) {
      const row = analysis.rows.find(
        (row) => row.requirement_id === r.requirement_id,
      );
      if (
        row?.fact_refs.some(
          (ref) =>
            ref.fact_id === fact.fact_id &&
            ref.fact_revision === fact.fact_revision,
        ) &&
        (row.status === 'matched' ||
          !r.term ||
          containsTerm(displayValue(fact.value), r.term))
      ) {
        relevance.push({
          requirement_id: r.requirement_id,
          kind: row.status === 'matched' ? 'matched' : 'related',
        });
      } else if (r.term && containsTerm(displayValue(fact.value), r.term)) {
        relevance.push({ requirement_id: r.requirement_id, kind: 'related' });
      }
    }
    if (fact.evidence_ids.length > 20)
      fail('单条事实证据超过 20 项，请先整理证据');
    const evidences = fact.evidence_ids.map((id) => {
      const e = profile.evidences.find((e) => e.evidence_id === id);
      if (!e) fail('事实原文证据已失效');
      return {
        evidence_id: e.evidence_id,
        document_id: e.document_id,
        block_id: e.block_id,
        page: e.page,
        quote: e.quote,
        start: e.start,
        end: e.end,
      };
    });
    const item: ResumeFact = {
      fact_id: fact.fact_id,
      fact_revision: fact.fact_revision,
      entity_id: fact.entity_id,
      category: fact.category,
      path: fact.path,
      value: structuredClone(fact.value),
      source_type: fact.source_type,
      evidences,
      relevance,
    };
    let block = blocks.find((b) => b.entity_id === fact.entity_id);
    if (!block) {
      block = {
        block_id: crypto.randomUUID(),
        entity_id: fact.entity_id,
        category: fact.category,
        facts: [],
      };
      blocks.push(block);
    }
    block.facts.push(item);
    if (block.facts.length > 60) fail('单段经历超过 60 条事实，请先整理经历');
  }
  if (blocks.length > 80) fail('经历分组超过 80 个，请先整理资料');
  const score = (b: ResumeBlock) => {
    const strongest = new Map<string, number>();
    for (const fact of b.facts)
      for (const rel of fact.relevance) {
        const req = job.requirements.find(
          (r) => r.requirement_id === rel.requirement_id,
        )!;
        const weight =
          (rel.kind === 'matched' ? 10 : 1) *
          (req.priority === 'hard' ? 3 : req.priority === 'core' ? 2 : 1);
        strongest.set(
          req.requirement_id,
          Math.max(strongest.get(req.requirement_id) ?? 0, weight),
        );
      }
    return [...strongest.values()].reduce((sum, n) => sum + n, 0);
  };
  const sectionRank = (c: Category) =>
    ['work', 'internship', 'project'].includes(c) ? 3 : categories.indexOf(c);
  blocks.sort(
    (a, b) =>
      sectionRank(a.category) - sectionRank(b.category) || score(b) - score(a),
  );
  const experience = (b: ResumeBlock) =>
    ['work', 'internship', 'project'].includes(b.category);
  const relevantExperience = new Set(
    blocks.filter((b) => experience(b) && score(b) > 0).map((b) => b.entity_id),
  );
  const defaultSelected = facts
    .filter(
      (f) =>
        !defaultHidden.has(f.path) &&
        (!['work', 'internship', 'project'].includes(f.category) ||
          !relevantExperience.size ||
          relevantExperience.has(f.entity_id)),
    )
    .map((f) => f.fact_id);
  const oldFacts = new Set(
    basedOn?.blocks.flatMap((b) => b.facts.map((f) => f.fact_id)) ?? [],
  );
  const selected = basedOn
    ? facts
        .filter((f) =>
          oldFacts.has(f.fact_id)
            ? basedOn.selected_fact_ids.includes(f.fact_id)
            : defaultSelected.includes(f.fact_id),
        )
        .map((f) => f.fact_id)
    : defaultSelected;
  if (basedOn) {
    const oldEntities = basedOn.block_order.map(
      (id) => basedOn.blocks.find((b) => b.block_id === id)!.entity_id,
    );
    const rank = (b: ResumeBlock) =>
      oldEntities.includes(b.entity_id)
        ? oldEntities.indexOf(b.entity_id)
        : oldEntities.length;
    blocks.sort((a, b) => rank(a) - rank(b));
  }
  if (!selected.length) fail('没有可用于简历的已确认事实，请先补充经历');
  const now = Date.now();
  const result: ResumeVariant = {
    schema_version: 1,
    resume_id: crypto.randomUUID(),
    based_on_resume_id: basedOn?.resume_id ?? null,
    job_id: job.job_id,
    job_revision: job.revision,
    job_source_hash: job.source_hash,
    job_title: job.attributes.find((a) => a.key === 'title')?.value ?? '',
    company: job.attributes.find((a) => a.key === 'company')?.value ?? '',
    requirements: job.requirements.map((r) => ({
      requirement_id: r.requirement_id,
      quote: r.quote,
    })),
    profile_revision: profile.profile_revision,
    engine_version: RESUME_ENGINE_VERSION + '/' + MATCH_ENGINE_VERSION,
    as_of: analysis.as_of,
    created_at: now,
    updated_at: now,
    revision: 1,
    blocks,
    name: nameOf(name),
    block_order: blocks.map((b) => b.block_id),
    selected_fact_ids: selected,
    status: 'draft',
    approved_at: null,
    change_note: basedOn
      ? '基于最新岗位与资料生成独立版本，保留原有内容选择和顺序'
      : '按岗位证据与相关线索初选和排列已确认经历，正文保持事实原值',
    history: [],
  };
  validateResumeVariant(result);
  return result;
}
function unique(ids: string[]) {
  return new Set(ids).size === ids.length;
}
export function validateResumeVariant(
  value: unknown,
): asserts value is ResumeVariant {
  if (!Value.Check(ResumeVariantSchema, value)) fail('岗位简历格式无效');
  const blocks = value.blocks,
    allFacts = blocks.flatMap((b) => b.facts),
    factIds = allFacts.map((f) => f.fact_id),
    blockIds = blocks.map((b) => b.block_id);
  if (
    !unique(factIds) ||
    !unique(blockIds) ||
    !unique(blocks.map((b) => b.entity_id)) ||
    allFacts.length > 400
  )
    fail('岗位简历引用重复或超限');
  if (!unique(value.requirements.map((r) => r.requirement_id)))
    fail('岗位简历要求引用重复');
  if (!validDate({ value: value.as_of, precision: 'day' }))
    fail('岗位简历计算日期无效');
  for (const block of blocks)
    for (const f of block.facts) {
      validateFactValue(f.path, f.value);
      if (
        f.category !== block.category ||
        f.entity_id !== block.entity_id ||
        !f.path.startsWith(block.category + '.')
      )
        fail('岗位简历经历实体无效');
      if (
        !unique(f.evidences.map((e) => e.evidence_id)) ||
        f.evidences.some((e) => e.end - e.start !== e.quote.length)
      )
        fail('岗位简历证据无效');
      if (
        !unique(f.relevance.map((r) => r.requirement_id)) ||
        f.relevance.some(
          (r) =>
            !value.requirements.some(
              (req) => req.requirement_id === r.requirement_id,
            ),
        )
      )
        fail('岗位简历关联要求无效');
    }
  let lastRevision = 0;
  for (const version of [...value.history, value]) {
    nameOf(version.name);
    if (
      !unique(version.block_order) ||
      version.block_order.length !== blockIds.length ||
      version.block_order.some((id) => !blockIds.includes(id))
    )
      fail('岗位简历分组顺序无效');
    if (
      !unique(version.selected_fact_ids) ||
      version.selected_fact_ids.some((id) => !factIds.includes(id))
    )
      fail('岗位简历选择的事实无效');
    if ((version.status === 'approved') !== (version.approved_at !== null))
      fail('岗位简历审核状态无效');
    if (version.revision <= lastRevision) fail('岗位简历修订顺序无效');
    lastRevision = version.revision;
  }
}
export function validateResumeGrounding(
  resume: ResumeVariant,
  profile: ProfileState,
  current = false,
) {
  validateResumeVariant(resume);
  const facts = current
    ? confirmedFacts(profile)
    : profile.facts.filter((f) => f.confirmation === 'confirmed');
  for (const block of resume.blocks)
    for (const item of block.facts) {
      const fact = facts.find(
        (f) =>
          f.fact_id === item.fact_id && f.fact_revision === item.fact_revision,
      );
      if (
        !fact ||
        fact.path !== item.path ||
        fact.category !== item.category ||
        fact.entity_id !== item.entity_id ||
        fact.source_type !== item.source_type ||
        canonicalJson(fact.value) !== canonicalJson(item.value) ||
        canonicalJson([...fact.evidence_ids].sort()) !==
          canonicalJson(item.evidences.map((e) => e.evidence_id).sort())
      )
        fail('简历内容与已确认事实不一致，请重新生成');
      for (const e of item.evidences) {
        const source = profile.evidences.find(
          (source) => source.evidence_id === e.evidence_id,
        );
        if (
          !source ||
          ['document_id', 'block_id', 'page', 'quote', 'start', 'end'].some(
            (k) => source[k as keyof typeof source] !== e[k as keyof typeof e],
          )
        )
          fail('简历原文证据已失效');
      }
    }
}
export function isResumeCurrent(
  resume: ResumeVariant,
  job: JobDocument | null | undefined,
  profile: ProfileState,
  asOf = new Date().toISOString().slice(0, 10),
) {
  return (
    !!job &&
    job.reviewed &&
    job.job_id === resume.job_id &&
    job.revision === resume.job_revision &&
    job.source_hash === resume.job_source_hash &&
    profile.profile_revision === resume.profile_revision &&
    resume.engine_version ===
      RESUME_ENGINE_VERSION + '/' + MATCH_ENGINE_VERSION &&
    resume.as_of === asOf
  );
}
function assertCurrent(
  resume: ResumeVariant,
  job: JobDocument,
  profile: ProfileState,
) {
  if (!isResumeCurrent(resume, job, profile))
    fail('岗位或资料已变化，请根据最新资料生成新版本');
  validateResumeGrounding(resume, profile, true);
  if (
    canonicalJson(resume.requirements) !==
      canonicalJson(
        job.requirements.map((r) => ({
          requirement_id: r.requirement_id,
          quote: r.quote,
        })),
      ) ||
    resume.job_title !==
      (job.attributes.find((a) => a.key === 'title')?.value ?? '') ||
    resume.company !==
      (job.attributes.find((a) => a.key === 'company')?.value ?? '')
  )
    fail('简历岗位来源不一致');
}
export interface ResumeEdit {
  name?: string;
  selected_fact_ids?: string[];
  block_order?: string[];
  restore_revision?: number;
  approve?: boolean;
}
export function reviseResumeVariant(
  resume: ResumeVariant,
  change: ResumeEdit,
  job: JobDocument,
  profile: ProfileState,
): ResumeVariant {
  assertCurrent(resume, job, profile);
  if (
    !Object.keys(change).length ||
    Object.keys(change).some(
      (k) =>
        ![
          'name',
          'selected_fact_ids',
          'block_order',
          'restore_revision',
          'approve',
        ].includes(k),
    )
  )
    fail('简历修订请求无效');
  if (change.approve && Object.keys(change).length !== 1)
    fail('修改内容后请单独审核');
  if (change.restore_revision !== undefined && Object.keys(change).length !== 1)
    fail('恢复历史版本时不能同时修改内容');
  const next = structuredClone(resume),
    previous = {
      revision: resume.revision,
      updated_at: resume.updated_at,
      name: resume.name,
      block_order: [...resume.block_order],
      selected_fact_ids: [...resume.selected_fact_ids],
      status: resume.status,
      approved_at: resume.approved_at,
      change_note: resume.change_note,
    };
  next.history = [...next.history, previous].slice(-10);
  next.revision++;
  next.updated_at = Date.now();
  next.status = 'draft';
  next.approved_at = null;
  if (change.restore_revision !== undefined) {
    const old = resume.history.find(
      (h) => h.revision === change.restore_revision,
    );
    if (!old) fail('该历史修订已不在保留范围');
    next.name = old.name;
    next.block_order = [...old.block_order];
    next.selected_fact_ids = [...old.selected_fact_ids];
    next.change_note =
      '恢复 v' + old.revision + ' 的名称、内容选择和顺序，需重新审核';
  } else {
    if (change.name !== undefined) next.name = nameOf(change.name);
    if (change.selected_fact_ids !== undefined)
      next.selected_fact_ids = [...change.selected_fact_ids];
    if (change.block_order !== undefined)
      next.block_order = [...change.block_order];
    const added = next.selected_fact_ids.filter(
      (id) => !resume.selected_fact_ids.includes(id),
    ).length;
    const removed = resume.selected_fact_ids.filter(
      (id) => !next.selected_fact_ids.includes(id),
    ).length;
    next.change_note = change.approve
      ? '用户核对内容与事实来源后审核通过'
      : `选入 ${added} 条，移除 ${removed} 条` +
        (canonicalJson(next.block_order) !== canonicalJson(resume.block_order)
          ? '；调整经历顺序'
          : '') +
        (next.name !== resume.name ? '；修改版本名称' : '');
    if (change.approve) {
      next.status = 'approved';
      next.approved_at = next.updated_at;
    }
  }
  validateResumeVariant(next);
  return next;
}
function immutableBasis(r: ResumeVariant) {
  return {
    ...r,
    revision: 0,
    updated_at: 0,
    name: '',
    block_order: [],
    selected_fact_ids: [],
    status: '',
    approved_at: null,
    change_note: '',
    history: [],
  };
}
export function putResumeVariant(
  state: CareerState,
  resume: ResumeVariant,
  expected: number | null = null,
): CareerState {
  validateResumeVariant(resume);
  const job = state.jobs.find((j) => j.job_id === resume.job_id),
    all = state.resumes ?? [],
    old = all.find((r) => r.resume_id === resume.resume_id);
  if (!job || job.revision !== resume.job_revision || !job.reviewed)
    fail('岗位已变化，请重新生成简历');
  if (expected === null ? !!old : old?.revision !== expected)
    fail('简历修订已变化，请重新读取');
  if (
    old &&
    (resume.revision !== old.revision + 1 ||
      canonicalJson(immutableBasis(old)) !==
        canonicalJson(immutableBasis(resume)))
  )
    fail('不能修改简历的事实来源快照');
  if (
    !old &&
    (resume.revision !== 1 ||
      resume.status !== 'draft' ||
      resume.history.length)
  )
    fail('新简历必须从待审核版本开始');
  if (!old && all.length >= 20)
    fail('最多保存 20 份岗位简历，请先删除不需要的版本');
  return {
    ...state,
    revision: state.revision + 1,
    resumes: [
      ...all.filter((r) => r.resume_id !== resume.resume_id),
      structuredClone(resume),
    ],
  };
}
export function resumeSelectedBlocks(resume: ResumeVariant) {
  return resume.block_order
    .map((id) => resume.blocks.find((b) => b.block_id === id)!)
    .map((b) => ({
      ...b,
      facts: b.facts.filter((f) =>
        resume.selected_fact_ids.includes(f.fact_id),
      ),
    }))
    .filter((b) => b.facts.length);
}
export function resumeValue(item: ResumeFact) {
  return typeof item.value !== 'string' && item.value.precision === 'present'
    ? '至今'
    : displayValue(item.value);
}
const clean = (s: string) =>
  Array.from(s)
    .filter(
      (c) =>
        (c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) ||
        ['\n', '\r', '\t'].includes(c),
    )
    .join('');
const html = (s: string) =>
  clean(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const markdown = (s: string) =>
  html(s).replace(/[\\`*_{}[\]()#+.!|>-]/g, '\\$&');
export function exportResume(
  resume: ResumeVariant,
  job: JobDocument,
  profile: ProfileState,
  format: 'markdown' | 'html',
): string {
  assertCurrent(resume, job, profile);
  if (resume.status !== 'approved' || !resume.approved_at)
    fail('请先审核岗位版简历再导出');
  const blocks = resumeSelectedBlocks(resume),
    name = blocks.flatMap((b) => b.facts).find((f) => f.path === 'basic.name');
  const heading = name ? resumeValue(name) : '个人简历';
  const target = [resume.job_title, resume.company].filter(Boolean).join(' · ');
  if (format === 'markdown') {
    const lines = [
      '# ' + markdown(heading),
      ...(target ? ['', '求职岗位：' + markdown(target)] : []),
    ];
    for (const block of blocks) {
      lines.push('', '## ' + resumeCategoryNames[block.category], '');
      for (const f of block.facts)
        lines.push(
          '- ' +
            resumeFactLabels[f.path] +
            '：' +
            markdown(resumeValue(f)).replace(/\n/g, '\n  '),
        );
    }
    return lines.join('\n') + '\n';
  }
  if (format !== 'html') fail('不支持的导出格式');
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>' +
    html(heading) +
    '</title><style>body{font:15px/1.65 system-ui,sans-serif;color:#172333;background:#fff;max-width:800px;margin:40px auto;padding:0 28px}h1{overflow-wrap:anywhere;font-size:30px;margin-bottom:4px}h2{font-size:18px;border-bottom:1px solid #b8c4d0;padding-bottom:5px;margin-top:24px}p{margin:7px 0;white-space:pre-wrap;overflow-wrap:anywhere}strong{font-weight:600}.target{color:#46586d}@page{size:A4;margin:18mm}@media print{body{margin:0;padding:0;max-width:none}h2{break-after:avoid}p{orphans:3;widows:3}}</style></head><body><h1>' +
    html(heading) +
    '</h1>' +
    (target ? '<p class="target">求职岗位：' + html(target) + '</p>' : '') +
    blocks
      .map(
        (b) =>
          '<section><h2>' +
          resumeCategoryNames[b.category] +
          '</h2>' +
          b.facts
            .map(
              (f) =>
                '<p><strong>' +
                resumeFactLabels[f.path] +
                '：</strong>' +
                html(resumeValue(f)) +
                '</p>',
            )
            .join('') +
          '</section>',
      )
      .join('') +
    '</body></html>'
  );
}
