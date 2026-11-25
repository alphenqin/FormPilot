import {
  validateAnswerDraft,
  validateAnswerInput,
  validateAnswerSnapshots,
} from './answer';
import { validateResumeVariant } from './resume';
import { Value } from '@sinclair/typebox/value';
import {
  JobModelOutputSchema,
  CareerStateSchema,
  hashJson,
  canonicalJson,
  type JobKind,
  type JobPriority,
  type JobCriterion,
  type JobRequirement,
  type JobSource,
  type ParsedJob,
  type JobDocument,
  type CareerState,
  type JobMatch,
  type JobMatchRow,
} from '@formpilot/contracts';
import {
  confirmedFacts,
  currentFacts,
  displayValue,
  validDate,
  type ProfileState,
  type Fact,
} from './index';
import { PlanningFault } from './planning';
export const MATCH_ENGINE_VERSION = 'evidence-match-0.1.0';
const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s,，、;；()（）._\-/]+/g, '');
function fail(code: ConstructorParameters<typeof PlanningFault>[0]): never {
  throw new PlanningFault(code);
}
export function sanitizeJobURL(value: string) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new Error('岗位来源地址无效');
  const route =
    u.pathname + (u.hash.startsWith('#/') ? u.hash.split('?')[0] : '');
  return (
    u.origin +
    route
      .split('/')
      .map((segment) =>
        /(@|%40)|[a-f0-9]{16,}|[a-zA-Z0-9_-]{30,}|\d{6,}/i.test(segment)
          ? ':private'
          : segment,
      )
      .join('/')
      .slice(0, 300)
  );
}
export function validateJobSource(source: JobSource) {
  if (
    !source.text.trim() ||
    source.text.length > 20000 ||
    source.text.includes('\u0000')
  )
    fail('INVALID_REQUEST');
  if (source.page_url) {
    try {
      if (sanitizeJobURL(source.page_url) !== source.page_url)
        fail('INVALID_REQUEST');
    } catch {
      fail('INVALID_REQUEST');
    }
  }
  if (source.method === 'page' && !source.page_url) fail('INVALID_REQUEST');
}
const degrees: [RegExp, string, number][] = [
  [/博士|doctor(?:ate)?|ph\.?d/i, '博士', 5],
  [/硕士|master/i, '硕士', 4],
  [/本科|学士|bachelor/i, '本科', 3],
  [/大专|专科|associate/i, '大专', 2],
  [/高中|中专|high school/i, '高中', 1],
];
function degree(value: string) {
  const match = degrees.filter(([r]) => r.test(value));
  return match.length === 1 ? { name: match[0]![1], rank: match[0]![2] } : null;
}
function degreeValue(value: string) {
  const key = norm(value);
  const groups: [string[], string, number][] = [
    [
      ['博士', '博士研究生', 'phd', 'ph.d.', 'doctorate', 'doctoral degree'],
      '博士',
      5,
    ],
    [
      ['硕士', '硕士研究生', 'master', "master's degree", 'master degree'],
      '硕士',
      4,
    ],
    [
      [
        '本科',
        '大学本科',
        '学士',
        'bachelor',
        "bachelor's degree",
        'bachelor degree',
      ],
      '本科',
      3,
    ],
    [['大专', '专科', '大学专科', 'associate degree'], '大专', 2],
    [['高中', '中专', 'high school'], '高中', 1],
  ];
  const found = groups.find(([names]) => names.some((n) => norm(n) === key));
  return found ? { name: found[1], rank: found[2] } : null;
}
function remaining(text: string, remove: RegExp) {
  return text.replace(remove, '').replace(/[\s.,，。；;:：()（）!！]/g, '');
}
function number(value: string) {
  if (/^\d/.test(value)) return Number(value);
  const nums: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (value === '十') return 10;
  if (value.includes('十')) {
    const [a, b] = value.split('十');
    return (a ? (nums[a] ?? NaN) : 1) * 10 + (b ? (nums[b] ?? NaN) : 0);
  }
  return nums[value] ?? NaN;
}
const unknown = (reason: string): JobCriterion => ({
  type: 'unknown',
  value: null,
  min_years: null,
  level: null,
  reason,
});
export function requirementCriterion(
  kind: JobKind,
  quote: string,
  term: string | null,
): JobCriterion {
  const q = quote.normalize('NFKC');
  if (/不要求|无需|不限|not required|no experience required/i.test(q))
    return unknown('NON_RESTRICTIVE_OR_NEGATED');
  if (
    /或|或者|之一|任一|and\/or|\bor\b|[\d一二三四五六七八九十]+\s*[-~～至]\s*[\d一二三四五六七八九十]+\s*年/i.test(
      q.replace(/或以上|or (?:higher|above)/gi, '以上'),
    )
  )
    return unknown('COMPOUND_OR_RANGE');
  if (kind === 'education') {
    const d = degree(q);
    if (!d) return unknown('EDUCATION_UNCLEAR');
    if (
      /全日制|统招|已毕业|已取得|毕业证|应届|届毕业|专业|工作经验|排名|院校|双一流|985|211|full.?time|graduated/i.test(
        q,
      )
    )
      return unknown('ADDITIONAL_EDUCATION_CONDITION');
    const degreePattern = degrees.find(([, name]) => name === d.name)![0];
    if (
      remaining(
        q.replace(degreePattern, ''),
        /岗位要求|学历要求|学位要求|及以上|或以上|以上|至少|最低|不少于|要求|必须|具备|拥有|学历|学位|为|是|需|的|至少|education|minimum|at least|or higher|or above|requires?|must have|degree|preferred|优先考虑|优先|a\b/gi,
      )
    )
      return unknown('COMPOUND_EDUCATION_REQUIREMENT');
    return {
      type: /以上|至少|最低|不少于|at least|minimum|or higher|or above/i.test(q)
        ? 'degree_min'
        : 'degree_exact',
      value: d.name,
      min_years: null,
      level: null,
      reason: null,
    };
  }
  if (kind === 'experience') {
    const years =
        /(\d+(?:\.\d+)?|[一二三四五六七八九十两]+)\s*\+?\s*(?:年|years?)/i.exec(
          q,
        ),
      n = years ? number(years[1]!) : NaN;
    if (!Number.isFinite(n) || n < 0 || n > 50)
      return unknown('EXPERIENCE_THRESHOLD_UNKNOWN');
    if (
      !/以上|至少|不少于|起|at least|minimum|\d\s*\+\s*(?:年|years?)/i.test(q)
    )
      return unknown('EXPERIENCE_OPERATOR_UNKNOWN');
    if (
      /相关|行业|全职|研发|开发|项目|管理|full.?time|relevant|industry|development|management/i.test(
        q,
      ) ||
      (term &&
        !/^(工作|工作经验|实习|实习经验|work experience|years?)$/i.test(term))
    )
      return unknown('EXPERIENCE_SCOPE_UNKNOWN');
    if (
      remaining(
        q.replace(years![0], ''),
        /任职要求|岗位要求|工作年限|经验要求|及以上|或以上|以上|至少|不少于|需要|要求|具备|拥有|工作|实习|经历|经验|的|需|起|at least|minimum|years?|of|work|internship|experience/gi,
      )
    )
      return unknown('COMPOUND_EXPERIENCE_REQUIREMENT');
    return {
      type: 'years_min',
      value: /实习|internship/i.test(q) ? 'internship' : 'work',
      min_years: n,
      level: null,
      reason: null,
    };
  }
  if (kind === 'skill') {
    if (!term?.trim() || !norm(q).includes(norm(term)))
      return unknown('SKILL_TERM_UNKNOWN');
    if (
      /经验|年|认证|证书|优秀|较强|良好|独立|深入|能力|experience|years?|certif/i.test(
        q,
      )
    )
      return unknown('ADDITIONAL_SKILL_CONDITION');
    if (/[和及与、,，/]|\band\b|\bor\b/i.test(term) && !/^ci\/cd$/i.test(term))
      return unknown('COMPOUND_SKILL_TERM');
    const literal = term.normalize('NFKC'),
      position = q.toLowerCase().indexOf(literal.toLowerCase());
    if (
      position < 0 ||
      remaining(
        q.slice(0, position) + q.slice(position + literal.length),
        /岗位要求|技能要求|熟练掌握|熟悉使用|精通|熟练|熟悉|掌握|了解|使用|具备|要求|必须|需要|需|基础|优先考虑|优先|加分|编程语言|语言|技术|knowledge of|proficient in|expert in|familiar with|skills?|required|must have|must/gi,
      )
    )
      return unknown('COMPOUND_SKILL_REQUIREMENT');
    const level = /精通|expert/i.test(q)
      ? 'expert'
      : /熟练|proficien/i.test(q)
        ? 'proficient'
        : /熟悉|掌握|familiar/i.test(q)
          ? 'familiar'
          : null;
    return { type: 'skill', value: term, min_years: null, level, reason: null };
  }
  if (kind === 'location') {
    if (
      !term?.trim() ||
      !norm(q).includes(norm(term)) ||
      /[、,，/]|全国|远程|remote|出差|落户|户籍|签证/i.test(q)
    )
      return unknown('LOCATION_SCOPE_UNKNOWN');
    const literal = term.normalize('NFKC'),
      position = q.toLowerCase().indexOf(literal.toLowerCase());
    if (
      position < 0 ||
      remaining(
        q.slice(0, position) + q.slice(position + literal.length),
        /工作地点|工作城市|办公地点|办公城市|岗位地点|现居|居住地|居住在|需在|需要|要求|接受|工作|为|所在地|location|based in|work in/gi,
      )
    )
      return unknown('COMPOUND_LOCATION_REQUIREMENT');
    return {
      type: /现居|居住在|based in/i.test(q)
        ? 'location_current'
        : 'location_intention',
      value: term,
      min_years: null,
      level: null,
      reason: null,
    };
  }
  if (kind === 'major') {
    if (
      !term?.trim() ||
      !norm(q).includes(norm(term)) ||
      /相关|类|学历|本科|硕士|博士|related/i.test(q)
    )
      return unknown('MAJOR_SCOPE_UNKNOWN');
    const literal = term.normalize('NFKC'),
      position = q.toLowerCase().indexOf(literal.toLowerCase());
    if (
      position < 0 ||
      remaining(
        q.slice(0, position) + q.slice(position + literal.length),
        /专业要求|专业背景|专业|要求|为|必须|需|背景|优先考虑|优先|major|in/gi,
      )
    )
      return unknown('COMPOUND_MAJOR_REQUIREMENT');
    return {
      type: 'major_exact',
      value: term.replace(/专业$/, ''),
      min_years: null,
      level: null,
      reason: null,
    };
  }
  return unknown('SEMANTIC_EVIDENCE_REVIEW_REQUIRED');
}
function inferKind(kind: JobKind, quote: string): JobKind {
  const d = degree(quote),
    years = /(?:\d+|[一二三四五六七八九十两]+)\s*(?:年|years?)/i.test(quote);
  if (d && !years) return 'education';
  if (years && !d) return 'experience';
  return kind;
}
function priority(value: JobPriority, quote: string): JobPriority {
  if (/优先|加分|prefer|nice.?to.?have/i.test(quote)) return 'preferred';
  if (/必须|至少|及以上|最低|不少于|\bmust\b|\brequired\b|minimum/i.test(quote))
    return 'hard';
  return value;
}
function anchor(text: string, quote: string) {
  const start = text.indexOf(quote);
  if (start < 0 || text.indexOf(quote, start + 1) >= 0)
    fail('EVIDENCE_INVALID');
  return { quote, start, end: start + quote.length };
}
export async function validateJobModel(
  source: JobSource,
  output: unknown,
  meta: {
    provider: string;
    model: string;
    usage: ParsedJob['usage'];
    duration_ms: number;
  },
): Promise<ParsedJob> {
  validateJobSource(source);
  if (!Value.Check(JobModelOutputSchema, output)) fail('MODEL_INVALID_OUTPUT');
  const seen = new Set<string>();
  const attributes = output.attributes.map((a) => {
    if (!a.quote.includes(a.value)) fail('EVIDENCE_INVALID');
    const span = anchor(source.text, a.quote),
      id = 'attribute:' + a.key + ':' + span.start;
    if (seen.has(id)) fail('MODEL_INVALID_OUTPUT');
    seen.add(id);
    return {
      ...a,
      ...span,
      attribute_id: crypto.randomUUID(),
      confirmed: false,
    };
  });
  const requirements = output.requirements.map((r) => {
    const span = anchor(source.text, r.quote),
      id = 'requirement:' + span.start + ':' + span.end;
    if (seen.has(id)) fail('MODEL_INVALID_OUTPUT');
    seen.add(id);
    if (r.term && !norm(r.quote).includes(norm(r.term)))
      fail('EVIDENCE_INVALID');
    const kind = inferKind(r.kind, r.quote);
    return {
      ...r,
      ...span,
      kind,
      priority: priority(r.priority, r.quote),
      criterion: requirementCriterion(kind, r.quote, r.term),
      requirement_id: crypto.randomUUID(),
      confirmed: false,
    };
  });
  return {
    schema_version: 1,
    source_hash: await hashJson(source),
    attributes,
    requirements,
    ...meta,
  };
}
export function emptyCareer(): CareerState {
  return { schema_version: 1, revision: 0, jobs: [], analyses: [] };
}
export async function acceptParsedJob(
  source: JobSource,
  parsed: ParsedJob,
): Promise<JobDocument> {
  validateJobSource(source);
  if (parsed.source_hash !== (await hashJson(source))) fail('EVIDENCE_INVALID');
  const now = Date.now();
  return {
    schema_version: 1,
    job_id: crypto.randomUUID(),
    source: structuredClone(source),
    source_hash: parsed.source_hash,
    revision: 1,
    attributes: structuredClone(parsed.attributes).map((a) => ({
      ...a,
      confirmed: false,
    })),
    requirements: structuredClone(parsed.requirements).map((r) => ({
      ...r,
      confirmed: false,
    })),
    reviewed: false,
    created_at: now,
    updated_at: now,
    provider: parsed.provider,
    model: parsed.model,
    usage: parsed.usage,
    duration_ms: parsed.duration_ms,
    history: [],
  };
}
export function putCareerJob(
  state: CareerState,
  job: JobDocument,
  expected: number | null = null,
): CareerState {
  const next = structuredClone(state),
    old = next.jobs.find((j) => j.job_id === job.job_id);
  if (expected !== null && old?.revision !== expected)
    fail('REVISION_CONFLICT');
  if (old && job.revision <= old.revision) fail('REVISION_CONFLICT');
  if (!old && next.jobs.length >= 20)
    throw new Error('最多保存 20 个岗位，请先删除不需要的岗位');
  next.jobs = [
    ...next.jobs.filter((j) => j.job_id !== job.job_id),
    structuredClone(job),
  ];
  next.analyses = next.analyses.filter(
    (a) =>
      a.job_id !== job.job_id ||
      a.job_revision === job.revision ||
      job.history.some((v) => v.revision === a.job_revision),
  );
  next.revision++;
  return next;
}
export function reviseJob(
  job: JobDocument,
  change: {
    confirm_all?: boolean;
    requirement?: {
      requirement_id: string;
      kind: JobKind;
      priority: JobPriority;
      term: string | null;
      confirmed: boolean;
    };
    add?: {
      quote: string;
      kind: JobKind;
      priority: JobPriority;
      term: string | null;
    };
    remove?: string;
    remove_attribute?: string;
  },
): JobDocument {
  const next = structuredClone(job),
    { revision, attributes, requirements, reviewed, updated_at } = job;
  next.history = [
    ...job.history,
    { revision, attributes, requirements, reviewed, updated_at },
  ].slice(-10);
  if (change.confirm_all) {
    next.requirements = next.requirements.map((r) => ({
      ...r,
      confirmed: true,
    }));
    next.attributes = next.attributes.map((a) => ({ ...a, confirmed: true }));
  }
  if (change.requirement) {
    const c = change.requirement,
      r = next.requirements.find((r) => r.requirement_id === c.requirement_id);
    if (!r) fail('REFERENCE_NOT_FOUND');
    if (c.term && !norm(r.quote).includes(norm(c.term)))
      fail('EVIDENCE_INVALID');
    const changed =
      r.kind !== c.kind || r.priority !== c.priority || r.term !== c.term;
    Object.assign(r, {
      ...c,
      criterion: requirementCriterion(c.kind, r.quote, c.term),
      confirmed: changed ? false : c.confirmed,
    });
  }
  if (change.add) {
    if (next.requirements.length >= 60) throw new Error('岗位要求数量已达上限');
    const a = change.add,
      span = anchor(job.source.text, a.quote);
    if (
      next.requirements.some(
        (r) => r.start === span.start && r.end === span.end,
      )
    )
      fail('RULE_VIOLATION');
    if (a.term && !norm(a.quote).includes(norm(a.term)))
      fail('EVIDENCE_INVALID');
    next.requirements.push({
      ...a,
      ...span,
      requirement_id: crypto.randomUUID(),
      criterion: requirementCriterion(a.kind, a.quote, a.term),
      confirmed: false,
    });
  }
  if (change.remove) {
    if (!next.requirements.some((r) => r.requirement_id === change.remove))
      fail('REFERENCE_NOT_FOUND');
    next.requirements = next.requirements.filter(
      (r) => r.requirement_id !== change.remove,
    );
  }
  if (change.remove_attribute) {
    if (
      !next.attributes.some((a) => a.attribute_id === change.remove_attribute)
    )
      fail('REFERENCE_NOT_FOUND');
    next.attributes = next.attributes.filter(
      (a) => a.attribute_id !== change.remove_attribute,
    );
  }
  next.reviewed =
    next.requirements.length > 0 &&
    next.requirements.every((r) => r.confirmed) &&
    next.attributes.every((a) => a.confirmed);
  next.revision++;
  next.updated_at = Date.now();
  return next;
}
const aliases: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  postgres: 'postgresql',
  postgresql: 'postgresql',
  'c++': 'c++',
  'c#': 'c#',
  golang: 'go',
};
function skillKey(s: string) {
  const k = s.normalize('NFKC').trim().toLowerCase();
  return aliases[k] ?? k;
}
function level(value: string) {
  if (/不|未|不会|不了解|不掌握|not|no /i.test(value)) return -1;
  if (/精通|expert/i.test(value)) return 3;
  if (/熟练|proficien/i.test(value)) return 2;
  if (/熟悉|掌握|familiar/i.test(value)) return 1;
  return 0;
}
function dayBound(
  value: Fact['value'],
  latest: boolean,
  asOf: string,
): number | null {
  if (typeof value === 'string' || !validDate(value)) return null;
  if (value.precision === 'present') return Date.parse(asOf + 'T00:00:00Z');
  if (value.precision === 'day') return Date.parse(value.value + 'T00:00:00Z');
  if (value.precision === 'year')
    return Date.parse(
      value.value + (latest ? '-12-31' : '-01-01') + 'T00:00:00Z',
    );
  const [y, m] = value.value.split('-').map(Number);
  return Date.UTC(
    y!,
    m! - 1,
    latest ? new Date(Date.UTC(y!, m!, 0)).getUTCDate() : 1,
  );
}
function months(intervals: [number, number][], ceil: boolean) {
  const merged: [number, number][] = [];
  for (const [a, b] of intervals.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged.reduce((total, [a, b]) => {
    const start = new Date(a),
      end = new Date(b);
    let n =
      (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
      end.getUTCMonth() -
      start.getUTCMonth();
    if (end.getUTCDate() < start.getUTCDate()) n--;
    n = Math.max(0, n);
    const exact = start.getUTCDate() === end.getUTCDate();
    return total + n + (ceil && !exact ? 1 : 0);
  }, 0);
}
function related(facts: Fact[], r: JobRequirement) {
  const term = r.term ?? r.criterion.value;
  return term
    ? facts
        .filter(
          (f) =>
            typeof f.value === 'string' && norm(f.value).includes(norm(term)),
        )
        .slice(0, 8)
    : [];
}
function row(
  r: JobRequirement,
  status: JobMatchRow['status'],
  reason: string,
  explanation: string,
  facts: Fact[] = [],
): JobMatchRow {
  if (facts.length > 100)
    return row(
      r,
      'insufficient',
      'REFERENCE_LIMIT',
      '相关经历过多，请缩小匹配范围后再审核。',
      facts.slice(0, 100),
    );
  return {
    requirement_id: r.requirement_id,
    status,
    reason_code: reason,
    explanation,
    fact_refs: facts.map((f) => ({
      fact_id: f.fact_id,
      fact_revision: f.fact_revision,
      entity_id: f.entity_id,
    })),
    evidence_ids: [...new Set(facts.flatMap((f) => f.evidence_ids))].slice(
      0,
      200,
    ),
  };
}
function yearsRow(
  r: JobRequirement,
  facts: Fact[],
  asOf: string,
  hasPending = false,
) {
  const category = r.criterion.value!,
    scope = facts.filter((f) => f.category === category),
    ids = [...new Set(scope.map((f) => f.entity_id))],
    min: [number, number][] = [],
    max: [number, number][] = [],
    refs: Fact[] = [];
  let incomplete = hasPending;
  for (const id of ids) {
    const start = scope.find(
        (f) => f.entity_id === id && f.path.endsWith('.start_date'),
      ),
      end = scope.find(
        (f) => f.entity_id === id && f.path.endsWith('.end_date'),
      );
    if (!start || !end) {
      incomplete = true;
      continue;
    }
    const sl = dayBound(start.value, false, asOf),
      sh = dayBound(start.value, true, asOf),
      el = dayBound(end.value, false, asOf),
      eh = dayBound(end.value, true, asOf),
      now = Date.parse(asOf + 'T00:00:00Z');
    if (
      [sl, sh, el, eh].some((v) => v === null) ||
      sl! > now ||
      eh! > now ||
      sl! > eh!
    ) {
      incomplete = true;
      continue;
    }
    max.push([sl!, eh!]);
    if (sh! <= el!) min.push([sh!, el!]);
    else incomplete = true;
    refs.push(start, end);
  }
  if (!ids.length)
    return row(
      r,
      'needs_confirmation',
      'NO_CONFIRMED_WORK_PERIODS',
      category === 'work'
        ? '未找到可核对的工作起止日期；实习和项目不作为工作年限。'
        : '未找到可核对的实习起止日期。',
    );
  const low = months(min, false),
    high = months(max, true),
    required = Math.ceil(r.criterion.min_years! * 12);
  if (low >= required)
    return row(
      r,
      'matched',
      'CONFIRMED_DURATION',
      '合并重叠经历后，已确认日期提供的保守工作时长下限达到要求。',
      refs,
    );
  if (!incomplete && high < required)
    return row(
      r,
      'unmatched',
      'CONFIRMED_DURATION_BELOW_MINIMUM',
      '合并重叠经历后，当前已确认记录的时长上限仍低于要求。',
      refs,
    );
  return row(
    r,
    'insufficient',
    'DURATION_PRECISION_OR_MISSING',
    '日期精度、缺少起止时间或记录范围不足以明确满足年限；没有补齐日期或累计重复时长。',
    refs,
  );
}
function matchOne(
  r: JobRequirement,
  job: JobDocument,
  profile: ProfileState,
  facts: Fact[],
  asOf: string,
): JobMatchRow {
  const c = r.criterion;
  if (c.type === 'unknown')
    return row(
      r,
      related(facts, r).length ? 'insufficient' : 'needs_confirmation',
      c.reason ?? 'SEMANTIC_REVIEW',
      '此条需要语义或额外条件审核，相关文字只作为线索，不能据关键词判定满足。',
      related(facts, r),
    );
  if (c.type === 'years_min')
    return yearsRow(
      r,
      facts,
      asOf,
      currentFacts(profile).some(
        (f) => f.category === c.value && f.confirmation === 'pending',
      ),
    );
  if (c.type === 'degree_min' || c.type === 'degree_exact') {
    const candidates = facts.filter((f) => f.path === 'education.degree'),
      threshold = degree(c.value!)!,
      eligible = candidates.find((f) => {
        const d = degreeValue(displayValue(f.value));
        return (
          d &&
          (c.type === 'degree_min'
            ? d.rank >= threshold.rank
            : d.rank === threshold.rank)
        );
      });
    if (eligible)
      return row(
        r,
        'matched',
        'CONFIRMED_EDUCATION',
        '已确认的学历名称满足这条明确的学历条件；不推断毕业状态或额外院校限制。',
        [eligible],
      );
    if (
      candidates.length &&
      candidates.every((f) => {
        const d = degreeValue(displayValue(f.value));
        return d && d.rank < threshold.rank;
      }) &&
      !currentFacts(profile).some(
        (f) => f.path === 'education.degree' && f.confirmation === 'pending',
      )
    )
      return row(
        r,
        'unmatched',
        'CONFIRMED_EDUCATION_BELOW_MINIMUM',
        '当前已确认学历记录低于这条要求。',
        candidates,
      );
    return row(
      r,
      candidates.length ? 'insufficient' : 'needs_confirmation',
      'EDUCATION_NOT_ESTABLISHED',
      '没有明确满足此学历条件的已确认事实；不把缺少记录判成不具备。',
      candidates,
    );
  }
  if (c.type === 'skill') {
    const names = facts.filter(
      (f) =>
        f.path === 'skill.name' &&
        typeof f.value === 'string' &&
        f.value
          .split(/[、,，;；\n]/)
          .some((s) => skillKey(s) === skillKey(c.value!)),
    );
    for (const name of names) {
      const ability = facts.find(
          (f) => f.path === 'skill.level' && f.entity_id === name.entity_id,
        ),
        rank = ability ? level(displayValue(ability.value)) : 0,
        needed =
          c.level === 'expert'
            ? 3
            : c.level === 'proficient'
              ? 2
              : c.level === 'familiar'
                ? 1
                : 0;
      if (rank < 0) continue;
      if (!c.level || rank >= needed)
        return row(
          r,
          'matched',
          'CONFIRMED_STRUCTURED_SKILL',
          '已确认的技能名称及同一技能实体的熟练度满足这条要求。',
          ability ? [name, ability] : [name],
        );
    }
    if (
      names.length &&
      names.every((name) => {
        const l = facts.find(
          (f) => f.path === 'skill.level' && f.entity_id === name.entity_id,
        );
        return l && level(displayValue(l.value)) < 0;
      })
    )
      return row(
        r,
        'unmatched',
        'EXPLICIT_SKILL_NEGATION',
        '当前已确认的技能熟练度明确表示不掌握此技能。',
        names.flatMap((n) => [
          n,
          ...facts.filter(
            (f) => f.entity_id === n.entity_id && f.path === 'skill.level',
          ),
        ]),
      );
    const refs = names.length
      ? names.flatMap((n) => [
          n,
          ...facts.filter(
            (f) => f.entity_id === n.entity_id && f.path === 'skill.level',
          ),
        ])
      : related(facts, r);
    return row(
      r,
      refs.length ? 'insufficient' : 'needs_confirmation',
      'SKILL_LEVEL_OR_EXPERIENCE_UNPROVEN',
      '关键词或经历描述只是相关证据；缺少明确技能事实或所需熟练度，不能判为满足。',
      refs,
    );
  }
  if (c.type === 'location_intention' || c.type === 'location_current') {
    const path =
        c.type === 'location_current' ? 'basic.current_city' : 'intention.city',
      candidates = facts.filter((f) => f.path === path),
      city = (v: string) => norm(v).replace(/市$/, '');
    const found = candidates.find(
      (f) =>
        typeof f.value === 'string' &&
        f.value.split(/[、,，;；/]/).some((v) => city(v) === city(c.value!)),
    );
    if (found)
      return row(
        r,
        'matched',
        'CONFIRMED_LOCATION_SCOPE',
        path === 'intention.city'
          ? '已确认意向城市包含该地点；没有复用现居城市。'
          : '已确认现居城市满足明确的居住地要求。',
        [found],
      );
    return row(
      r,
      candidates.length ? 'insufficient' : 'needs_confirmation',
      'LOCATION_INTENT_NOT_CONFIRMED',
      path === 'intention.city'
        ? '请确认是否接受该工作地点；当前住在哪里不代表求职意向。'
        : '缺少符合这条居住地要求的明确记录。',
      candidates,
    );
  }
  if (c.type === 'major_exact') {
    const candidates = facts.filter(
        (f) =>
          f.path === 'education.major' &&
          norm(displayValue(f.value)).replace(/专业$/, '') === norm(c.value!),
      ),
      degreeRules = job.requirements.filter(
        (r) =>
          r.criterion.type === 'degree_min' ||
          r.criterion.type === 'degree_exact',
      );
    if (
      job.requirements.some(
        (r) => r.kind === 'education' && r.criterion.type === 'unknown',
      )
    )
      return row(
        r,
        'insufficient',
        'EDUCATION_CONTEXT_UNCLEAR',
        '同一学历背景还有未能核实的要求，不能跨经历拼凑。',
        candidates,
      );
    const eligible = candidates.find((f) =>
      degreeRules.every((rule) =>
        facts.some(
          (d) =>
            d.entity_id === f.entity_id &&
            d.path === 'education.degree' &&
            degreeValue(displayValue(d.value)) &&
            (rule.criterion.type === 'degree_min'
              ? degreeValue(displayValue(d.value))!.rank >=
                degree(rule.criterion.value!)!.rank
              : degreeValue(displayValue(d.value))!.rank ===
                degree(rule.criterion.value!)!.rank),
        ),
      ),
    );
    if (eligible)
      return row(
        r,
        'matched',
        'CONFIRMED_SAME_EDUCATION_ENTITY',
        '明确专业名称匹配，且没有借用其他教育经历的学历拼凑条件。',
        [
          eligible,
          ...facts.filter(
            (f) =>
              f.entity_id === eligible.entity_id &&
              f.path === 'education.degree',
          ),
        ],
      );
    return row(
      r,
      candidates.length ? 'insufficient' : 'needs_confirmation',
      'MAJOR_SAME_ENTITY_UNPROVEN',
      '需要明确专业记录及同一教育经历的相关学历；不自动推断“相关专业”。',
      candidates,
    );
  }
  return row(
    r,
    'needs_confirmation',
    'MANUAL_SEMANTIC_REVIEW',
    '请核实原文与经历证据。',
  );
}
export async function matchJob(
  job: JobDocument,
  profile: ProfileState,
  asOf = new Date().toISOString().slice(0, 10),
): Promise<JobMatch> {
  if (
    !job.reviewed ||
    !job.requirements.length ||
    job.requirements.some((r) => !r.confirmed)
  )
    throw new Error('请先核对并确认岗位要求');
  if (!validDate({ value: asOf, precision: 'day' })) fail('INVALID_REQUEST');
  const facts = confirmedFacts(profile),
    rows = job.requirements.map((r) => matchOne(r, job, profile, facts, asOf)),
    summary = {
      matched: 0,
      insufficient: 0,
      needs_confirmation: 0,
      unmatched: 0,
    };
  for (const r of rows) summary[r.status]++;
  return {
    schema_version: 1,
    analysis_id: crypto.randomUUID(),
    job_id: job.job_id,
    job_revision: job.revision,
    job_digest: await hashJson({
      source_hash: job.source_hash,
      revision: job.revision,
      requirements: job.requirements,
    }),
    profile_revision: profile.profile_revision,
    engine_version: MATCH_ENGINE_VERSION,
    as_of: asOf,
    created_at: Date.now(),
    rows,
    summary,
    final_hiring_decision: false,
  };
}
export function putJobMatch(state: CareerState, analysis: JobMatch) {
  const job = state.jobs.find((j) => j.job_id === analysis.job_id);
  if (!job || job.revision !== analysis.job_revision) fail('REVISION_CONFLICT');
  return {
    ...state,
    revision: state.revision + 1,
    analyses: [
      ...state.analyses.filter((a) => a.analysis_id !== analysis.analysis_id),
      structuredClone(analysis),
    ].slice(-60),
  };
}
export function validateCareerState(
  state: unknown,
): asserts state is CareerState {
  if (!Value.Check(CareerStateSchema, state))
    throw new Error('岗位资料格式无效');
  if (new Set(state.jobs.map((j) => j.job_id)).size !== state.jobs.length)
    throw new Error('岗位引用重复');
  if (
    state.pending &&
    new Set(state.pending.map((p) => p.request.client_request_id)).size !==
      state.pending.length
  )
    throw new Error('JD 解析检查点重复');
  for (const pending of state.pending ?? [])
    validateJobSource(pending.request.source);
  for (const job of state.jobs) {
    validateJobSource(job.source);
    for (const version of [job, ...job.history]) {
      if (
        new Set(version.requirements.map((r) => r.requirement_id)).size !==
        version.requirements.length
      )
        throw new Error('岗位要求引用重复');
      for (const r of [...version.requirements, ...version.attributes])
        if (
          job.source.text.slice(r.start, r.end) !== r.quote ||
          r.end - r.start !== r.quote.length
        )
          throw new Error('岗位原文引用无效');
      for (const a of version.attributes)
        if (!a.quote.includes(a.value)) throw new Error('岗位属性脱离原文');
      for (const r of version.requirements)
        if (r.term && !norm(r.quote).includes(norm(r.term)))
          throw new Error('岗位关键词脱离原文');
      for (const r of version.requirements)
        if (
          canonicalJson(r.criterion) !==
          canonicalJson(requirementCriterion(r.kind, r.quote, r.term))
        )
          throw new Error('岗位条件与原文不一致');
      if (
        version.reviewed &&
        (!version.requirements.length ||
          version.requirements.some((r) => !r.confirmed) ||
          version.attributes.some((a) => !a.confirmed))
      )
        throw new Error('岗位确认状态无效');
    }
  }
  if (
    new Set((state.resumes ?? []).map((r) => r.resume_id)).size !==
    (state.resumes ?? []).length
  )
    throw new Error('岗位简历标识重复');
  for (const resume of state.resumes ?? []) {
    if (!state.jobs.some((j) => j.job_id === resume.job_id))
      throw new Error('岗位简历来源不存在');
    validateResumeVariant(resume);
  }
  for (const list of [
    state.answers?.map((a) => a.answer_id) ?? [],
    state.answer_pending?.map((p) => p.request.client_request_id) ?? [],
  ])
    if (new Set(list).size !== list.length) throw new Error('开放题标识重复');
  for (const answer of state.answers ?? []) {
    if (!state.jobs.some((j) => j.job_id === answer.input.job.job_id))
      throw new Error('开放题来源岗位不存在');
    validateAnswerDraft(answer);
  }
  for (const pending of state.answer_pending ?? []) {
    if (!state.jobs.some((j) => j.job_id === pending.request.input.job.job_id))
      throw new Error('开放题检查点来源不存在');
    validateAnswerInput(pending.request.input);
    validateAnswerSnapshots(pending.request.input, pending.facts);
  }
  for (const analysis of state.analyses) {
    const job = state.jobs.find((j) => j.job_id === analysis.job_id);
    if (!job) throw new Error('岗位分析引用无效');
    if (
      analysis.rows.length > 60 ||
      new Set(analysis.rows.map((r) => r.requirement_id)).size !==
        analysis.rows.length
    )
      throw new Error('岗位分析字段无效');
  }
}

export async function manualJob(source: JobSource) {
  return acceptParsedJob(source, {
    schema_version: 1,
    source_hash: await hashJson(source),
    attributes: [],
    requirements: [],
    provider: 'local',
    model: 'manual',
    usage: { input_tokens: 0, output_tokens: 0 },
    duration_ms: 0,
  });
}
export function isJobMatchCurrent(
  analysis: JobMatch,
  job: JobDocument,
  profile: ProfileState,
  asOf = new Date().toISOString().slice(0, 10),
) {
  return (
    analysis.job_id === job.job_id &&
    analysis.job_revision === job.revision &&
    analysis.profile_revision === profile.profile_revision &&
    analysis.as_of === asOf &&
    analysis.engine_version === MATCH_ENGINE_VERSION
  );
}
