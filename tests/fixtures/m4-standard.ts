import {
  emptyProfile,
  importExtraction,
  reviseFact,
  currentFacts,
  confirmedFacts,
  type ProfileState,
} from '@formpilot/domain';
import {
  type Candidate,
  type FactPath,
  type FactValue,
  type FillPlanRequest,
  type FormSnapshot,
  type PlanFact,
} from '@formpilot/contracts';
import { syntheticDocument } from './resumes/synthetic';
export const STANDARD_VERSION = 'synthetic-1';
export const standardTemplates = ['basic', 'education', 'internships'] as const;
export type StandardTemplate = (typeof standardTemplates)[number];
export function standardSample(index: number) {
  const n = String(index + 1).padStart(2, '0'),
    start = String(2019 + (index % 3)),
    end = String(Number(start) + 4);
  const values = {
    name: '合成候选' + n,
    email: 'synthetic' + n + '@example.test',
    phone: '138000000' + n,
    current_city: index % 2 ? '苏州' : '杭州',
    intention_city: index % 2 ? '杭州' : '北京',
    school: '虚构大学' + n,
    major: index % 2 ? '计算机科学' : '软件工程',
    degree: index % 2 ? '硕士' : '本科',
    edu_start: start + '-09',
    edu_end: end + '-06',
    company_a: '虚构公司甲' + n,
    position_a: '虚构研发岗位甲' + n,
    start_a: '2023-01',
    end_a: '2023-07',
    company_b: '虚构公司乙' + n,
    position_b: '虚构研发岗位乙' + n,
    start_b: '2023-04',
    end_b: '2023-09',
  };
  const rows: { path: FactPath; value: FactValue; entity: string }[] = [
    { path: 'basic.name', value: values.name, entity: '基本信息' },
    { path: 'basic.email', value: values.email, entity: '基本信息' },
    { path: 'basic.phone', value: values.phone, entity: '基本信息' },
    {
      path: 'basic.current_city',
      value: values.current_city,
      entity: '基本信息',
    },
    {
      path: 'intention.city',
      value: values.intention_city,
      entity: '求职意向',
    },
    { path: 'education.school', value: values.school, entity: '教育经历' },
    { path: 'education.major', value: values.major, entity: '教育经历' },
    { path: 'education.degree', value: values.degree, entity: '教育经历' },
    {
      path: 'education.start_date',
      value: { value: values.edu_start, precision: 'month' },
      entity: '教育经历',
    },
    {
      path: 'education.end_date',
      value: { value: values.edu_end, precision: 'month' },
      entity: '教育经历',
    },
    ...(['a', 'b'] as const).flatMap((key) => [
      {
        path: 'internship.company' as const,
        value: values[`company_${key}`],
        entity: '实习' + key,
      },
      {
        path: 'internship.position' as const,
        value: values[`position_${key}`],
        entity: '实习' + key,
      },
      {
        path: 'internship.start_date' as const,
        value: { value: values[`start_${key}`], precision: 'month' as const },
        entity: '实习' + key,
      },
      {
        path: 'internship.end_date' as const,
        value: { value: values[`end_${key}`], precision: 'month' as const },
        entity: '实习' + key,
      },
    ]),
  ];
  const quotes = rows.map(
    (r) =>
      r.entity +
      ' ' +
      r.path +
      '：' +
      (typeof r.value === 'string' ? r.value : r.value.value),
  );
  const document = syntheticDocument(
    '完全虚构的 M4 标准简历 ' +
      n +
      '，禁止作为真实用户数据。\n' +
      quotes.join('\n'),
  );
  const candidates: Candidate[] = rows.map((r, i) => ({
    category: r.path.split('.')[0]!,
    path: r.path,
    value: r.value,
    entity_key: r.entity,
    block_id: document.blocks.find((b) => b.text.includes(quotes[i]!))!
      .block_id,
    quote: quotes[i]!,
  }));
  let profile = importExtraction(
    { ...emptyProfile(), documents: [document] },
    document.document_id,
    { candidates },
  );
  for (const f of currentFacts(profile))
    profile = reviseFact(profile, f.fact_id, { confirmation: 'confirmed' });
  return { id: 'sample-' + n, profile, values };
}
export function standardRequest(
  profile: ProfileState,
  snapshot: FormSnapshot,
): FillPlanRequest {
  const facts: PlanFact[] = confirmedFacts(profile).map(
    ({
      fact_id,
      fact_revision,
      profile_revision,
      category,
      path,
      value,
      entity_id,
      source_type,
      evidence_ids,
      document_id,
    }) => ({
      fact_id,
      fact_revision,
      profile_revision,
      category,
      path,
      value,
      entity_id,
      source_type,
      evidence_ids,
      document_id,
      confirmation: 'confirmed',
    }),
  );
  return {
    schema_version: 1,
    client_request_id: crypto.randomUUID(),
    task_id: snapshot.task_id,
    expected_plan_revision: 0,
    profile_revision: profile.profile_revision,
    form_snapshot: snapshot,
    confirmed_facts: facts,
    entities: profile.entities,
    evidences: profile.evidences,
    task_answers: [],
    consent: {
      granted: true,
      purpose: 'fill_plan',
      provider: 'controlled-rules',
      model: 'no-model-call',
      policy_url: 'https://example.test/policy',
      payload_hash: 'a'.repeat(64),
      granted_at: Date.now(),
    },
  };
}
