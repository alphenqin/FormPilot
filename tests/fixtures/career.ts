import {
  acceptParsedJob,
  validateJobModel,
  reviseJob,
  addManualFact,
  reviseFact,
  emptyProfile,
  type ProfileState,
} from '@formpilot/domain';
import type {
  JobSource,
  JobKind,
  JobPriority,
  FactPath,
  FactValue,
} from '@formpilot/contracts';
export function jobSource(
  text = '职位：后端工程师\n公司：虚构科技\n本科及以上学历。\n熟练掌握Java。\n至少3年工作经验。\n工作地点：北京\n硕士及以上学历优先。',
): JobSource {
  return {
    source_id: crypto.randomUUID(),
    text,
    title_hint: '合成岗位',
    page_url: null,
    captured_at: Date.now(),
    method: 'paste',
  };
}
export async function reviewedJob(
  clauses: {
    quote: string;
    kind: JobKind;
    term?: string | null;
    priority?: JobPriority;
  }[],
) {
  const source = jobSource(clauses.map((c) => c.quote).join('\n'));
  const parsed = await validateJobModel(
    source,
    {
      attributes: [],
      requirements: clauses.map((c) => ({
        kind: c.kind,
        priority: c.priority ?? 'hard',
        quote: c.quote,
        term: c.term ?? null,
      })),
    },
    {
      provider: 'controlled',
      model: 'test',
      usage: { input_tokens: 0, output_tokens: 0 },
      duration_ms: 0,
    },
  );
  return reviseJob(await acceptParsedJob(source, parsed), {
    confirm_all: true,
  });
}
export function profileFact(
  p: ProfileState,
  path: FactPath,
  value: FactValue,
  entity: string | null = null,
  confirmed = true,
) {
  let state = addManualFact(p, path, value, entity);
  const f = state.facts.at(-1)!;
  if (confirmed)
    state = reviseFact(state, f.fact_id, { confirmation: 'confirmed' });
  return { profile: state, entity_id: f.entity_id, fact_id: f.fact_id };
}
export function workPeriod(
  profile: ProfileState,
  start: string,
  end: string,
  id: string | null = null,
  category: 'work' | 'internship' = 'work',
) {
  let p = profileFact(profile, `${category}.company`, '虚构单位', id);
  p = profileFact(
    p.profile,
    `${category}.start_date`,
    {
      value: start,
      precision:
        start.length === 4 ? 'year' : start.length === 7 ? 'month' : 'day',
    },
    p.entity_id,
  );
  p = profileFact(
    p.profile,
    `${category}.end_date`,
    {
      value: end,
      precision:
        end === 'present'
          ? 'present'
          : end.length === 4
            ? 'year'
            : end.length === 7
              ? 'month'
              : 'day',
    },
    p.entity_id,
  );
  return p.profile;
}
export function qualifiedProfile() {
  let p = profileFact(emptyProfile(), 'education.degree', '本科');
  p = profileFact(p.profile, 'education.major', '软件工程', p.entity_id);
  p = profileFact(p.profile, 'skill.name', 'Java');
  p = profileFact(p.profile, 'skill.level', '熟练', p.entity_id);
  p = profileFact(p.profile, 'intention.city', '北京');
  return workPeriod(p.profile, '2020-01-01', '2024-01-01');
}
