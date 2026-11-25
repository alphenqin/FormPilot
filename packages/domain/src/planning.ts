import { Value } from '@sinclair/typebox/value';
import {
  FillPlanRequestSchema,
  ModelMappingSchema,
  PATHS,
  canonicalJson,
  hashJson,
  digestiblePlan,
  snapshotRef,
  type FillPlanRequest,
  type ModelMappings,
  type FillPlan,
  type FieldDecision,
  type PlanQuestion,
  type TaskAnswer,
  type EntityBinding,
  type ResolveRequest,
  type ScannedField,
  type FactPath,
  type FieldValue,
  type PlanFact,
  type Category,
  type ErrorCode,
} from '@formpilot/contracts';
import { validateFactValue, validateCandidates, validDate } from './index';
export class PlanningFault extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}
function fail(code: ErrorCode): never {
  throw new PlanningFault(code);
}
const normalize = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_\-:：()（）【】[\]*＊/]+/g, '');
const forbidden =
  /密码|验证码|校验码|支付|银行卡|信用卡|身份证|护照|password|captcha|passcode|one.?time.?code|credit.?card|payment|passport|cc-number/i;
const thirdParty =
  /紧急|推荐人|推荐者|父亲|母亲|家属|referee|emergency|referencecontact/i;
const consentField =
  /同意|隐私|条款|承诺|授权|声明|terms|privacy|consent|agree/i;
const experience = new Set([
  'education',
  'work',
  'internship',
  'project',
  'certificate',
]);
const aliases: Partial<Record<FactPath, string[]>> = {
  'basic.name': [
    '姓名',
    '真实姓名',
    '申请人姓名',
    '中文姓名',
    'fullname',
    'name',
  ],
  'basic.gender': ['性别', 'gender', 'sex'],
  'basic.phone': [
    '联系电话',
    '手机号码',
    '手机号',
    '移动电话',
    '手机',
    '电话',
    'phone',
    'mobile',
    'phonenumber',
  ],
  'basic.email': ['电子邮箱', '电子邮件', '邮箱', 'email', 'emailaddress'],
  'basic.current_city': [
    '现居城市',
    '现居地',
    '居住城市',
    '当前居住城市',
    'currentcity',
    'residencecity',
  ],
  'intention.city': [
    '意向城市',
    '期望城市',
    '期望工作城市',
    '目标城市',
    '意向工作地点',
    'desiredcity',
    'targetcity',
  ],
  'intention.industry': ['意向行业', '期望行业', 'desiredindustry'],
  'intention.position': [
    '意向岗位',
    '期望职位',
    '意向职位',
    '期望岗位',
    'desiredposition',
  ],
  'intention.salary': [
    '期望薪资',
    '期望工资',
    '期望月薪',
    'salaryexpectation',
    'expectedsalary',
  ],
  'education.school': [
    '学校',
    '学校名称',
    '毕业院校',
    '就读学校',
    'school',
    'university',
  ],
  'education.major': ['专业', '所学专业', 'major'],
  'education.degree': ['学历', '最高学历', '学位', 'degree', 'highestdegree'],
  'education.start_date': [
    '入学时间',
    '入学日期',
    '入学年月',
    'enrollmentdate',
  ],
  'education.end_date': [
    '毕业时间',
    '毕业日期',
    '毕业月份',
    '毕业年月',
    'graduationdate',
    'graduation',
  ],
  'project.name': ['项目名称', 'projectname'],
  'project.role': ['项目角色', 'projectrole'],
  'project.description': ['项目描述', 'projectdescription'],
  'skill.name': ['技能', '专业技能', '技能名称', '技术栈', 'skills'],
  'skill.level': ['熟练程度', '技能等级', 'skilllevel'],
  'certificate.name': ['证书名称', '证书', 'certificatename'],
  'certificate.number': ['证书编号', '证书号码', 'certificatenumber'],
  'certificate.date': ['取得时间', '获取时间', '取得日期', 'certificatedate'],
};
const labels: Partial<Record<FactPath, string>> = {
  'basic.name': '姓名',
  'basic.gender': '性别',
  'basic.phone': '联系电话',
  'basic.email': '邮箱',
  'basic.current_city': '现居城市',
  'intention.city': '意向城市',
  'intention.salary': '期望薪资',
  'intention.position': '意向岗位',
  'education.school': '学校',
  'education.major': '专业',
  'education.degree': '学历',
  'education.start_date': '入学时间',
  'education.end_date': '毕业时间',
  'work.company': '工作单位',
  'work.position': '工作职位',
  'work.start_date': '工作开始时间',
  'work.end_date': '工作结束时间',
  'internship.company': '实习单位',
  'internship.position': '实习岗位',
  'project.name': '项目名称',
};
export interface PlanningContext {
  input: FillPlanRequest;
  mappings: ModelMappings;
  model_error: string | null;
  question_catalog: PlanQuestion[];
  answers: TaskAnswer[];
  bindings: EntityBinding[];
  modes: Record<string, 'keep' | 'replace' | 'cancel' | 'manual'>;
  replacement_values: Record<string, FieldValue>;
  edited: Record<string, TaskAnswer>;
  semantic_overrides: Record<string, FactPath>;
  task_entities: { entity_id: string; category: Category; label: string }[];
}
const own = <T>(object: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(object, key) ? object[key] : undefined;
export function groupCategory(label: string): Category | null {
  if (/实习|internship/i.test(label)) return 'internship';
  if (/教育|学历|education/i.test(label)) return 'education';
  if (/工作经历|工作经验|任职经历|employment|work.?experience/i.test(label))
    return 'work';
  if (/项目|project/i.test(label)) return 'project';
  if (/证书|certificate/i.test(label)) return 'certificate';
  return null;
}
function groupTrail(input: FillPlanRequest, field: ScannedField) {
  const list = [];
  let id: string | null = field.group_id;
  for (let i = 0; id && i < 501; i++) {
    const group = input.form_snapshot.groups.find((g) => g.group_id === id);
    if (!group) fail('REFERENCE_NOT_FOUND');
    list.push(group);
    id = group.parent_group_id;
  }
  return list;
}
export function semanticPath(
  input: FillPlanRequest,
  field: ScannedField,
  boundCategory?: Category,
): FactPath | null {
  const primary = normalize(field.manual_label || field.label);
  if (thirdParty.test([primary, field.name, field.description].join(' ')))
    return null;
  for (const [path, names] of Object.entries(aliases))
    if (names!.some((name) => normalize(name) === primary))
      return path as FactPath;
  const category =
    boundCategory ??
    groupTrail(input, field)
      .map((g) => groupCategory(g.label))
      .find(Boolean);
  const generic: Record<string, string[]> = {
    company: [
      '公司名称',
      '公司',
      '单位名称',
      '工作单位',
      '实习单位',
      'company',
      'employer',
    ],
    position: ['职位', '岗位', '职务', 'position', 'jobtitle'],
    department: ['部门', '所属部门', 'department'],
    start_date: ['开始时间', '开始日期', '起始时间', '起始日期', 'startdate'],
    end_date: ['结束时间', '结束日期', '截止时间', 'enddate'],
    description: ['工作内容', '实习内容', '职责', '工作描述', 'description'],
  };
  if (category) {
    for (const [suffix, names] of Object.entries(generic))
      if (names.some((name) => normalize(name) === primary)) {
        const path = category + '.' + suffix;
        if ((PATHS as readonly string[]).includes(path))
          return path as FactPath;
      }
  }
  if (
    field.label_source === 'unknown' ||
    ['name', 'id', 'placeholder'].includes(field.label_source)
  ) {
    const fallback = normalize(
      field.name || field.html_id || field.placeholder,
    );
    for (const [path, names] of Object.entries(aliases))
      if (names!.some((name) => normalize(name) === fallback))
        return path as FactPath;
  }
  return null;
}
function bindingGroup(
  input: FillPlanRequest,
  field: ScannedField,
  category: Category,
) {
  return (
    groupTrail(input, field).find((g) => groupCategory(g.label) === category)
      ?.group_id ?? field.group_id
  );
}
function keyFor(group_id: string, category: Category) {
  return group_id + ':' + category;
}
export function validatePlanningInput(input: FillPlanRequest) {
  if (!Value.Check(FillPlanRequestSchema, input)) fail('INVALID_REQUEST');
  const s = input.form_snapshot;
  if (s.task_id !== input.task_id || s.frame_id !== 0) fail('SCOPE_DENIED');
  if (!/^https?:$/.test(new URL(s.origin).protocol) || s.route.includes('?'))
    fail('INVALID_REQUEST');
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (
    !unique(s.fields.map((f) => f.field_id)) ||
    !unique(s.fields.map((f) => f.locator_ref)) ||
    !unique(s.groups.map((g) => g.group_id)) ||
    !unique(input.confirmed_facts.map((f) => f.fact_id)) ||
    !unique(input.entities.map((e) => e.entity_id)) ||
    !unique(input.evidences.map((e) => e.evidence_id))
  )
    fail('RULE_VIOLATION');
  for (const field of s.fields) {
    const group = s.groups.find((g) => g.group_id === field.group_id);
    if (!group || group.form_id !== field.form_id) fail('SCOPE_DENIED');
    groupTrail(input, field);
  }
  for (const group of s.groups) {
    const seen = new Set<string>();
    let current: typeof group | undefined = group;
    while (current) {
      if (seen.has(current.group_id)) fail('RULE_VIOLATION');
      seen.add(current.group_id);
      if (!current.parent_group_id) break;
      current = s.groups.find((g) => g.group_id === current!.parent_group_id);
      if (!current) fail('REFERENCE_NOT_FOUND');
    }
  }
  for (const fact of input.confirmed_facts) {
    if (
      !fact.path.startsWith(fact.category + '.') ||
      fact.profile_revision > input.profile_revision ||
      !input.entities.some(
        (e) => e.entity_id === fact.entity_id && e.category === fact.category,
      )
    )
      fail('SCOPE_DENIED');
    try {
      validateFactValue(fact.path, fact.value);
    } catch {
      fail('RULE_VIOLATION');
    }
    for (const id of fact.evidence_ids) {
      const evidence = input.evidences.find((e) => e.evidence_id === id);
      if (
        !evidence ||
        evidence.document_id !== fact.document_id ||
        evidence.end - evidence.start !== evidence.quote.length
      )
        fail('EVIDENCE_INVALID');
    }
    if (fact.source_type === 'resume') {
      if (!fact.evidence_ids.length || !fact.document_id)
        fail('EVIDENCE_INVALID');
      for (const id of fact.evidence_ids) {
        const e = input.evidences.find((e) => e.evidence_id === id)!;
        try {
          validateCandidates(
            {
              document_id: e.document_id,
              blocks: [
                {
                  block_id: e.block_id,
                  document_id: e.document_id,
                  document_revision: 1,
                  page: e.page,
                  text: e.quote,
                  start: 0,
                  end: e.quote.length,
                },
              ],
            },
            {
              candidates: [
                {
                  category: fact.category,
                  path: fact.path,
                  value: fact.value,
                  entity_key: fact.entity_id,
                  block_id: e.block_id,
                  quote: e.quote,
                },
              ],
            },
          );
        } catch {
          fail('EVIDENCE_INVALID');
        }
      }
    }
  }
}
export function newPlanningContext(
  input: FillPlanRequest,
  mappings: ModelMappings,
  model_error: string | null = null,
): PlanningContext {
  validatePlanningInput(input);
  return {
    input: structuredClone(input),
    mappings: structuredClone(mappings),
    model_error,
    question_catalog: [],
    answers: structuredClone(input.task_answers),
    bindings: [],
    modes: {},
    replacement_values: {},
    edited: {},
    semantic_overrides: {},
    task_entities: [],
  };
}
export function validateModelMappings(
  input: FillPlanRequest,
  value: unknown,
): ModelMappings {
  if (!Value.Check(ModelMappingSchema, value)) fail('MODEL_INVALID_OUTPUT');
  const ids = new Set<string>();
  for (const mapping of value.mappings) {
    if (
      ids.has(mapping.field_id) ||
      !input.form_snapshot.fields.some(
        (field) => field.field_id === mapping.field_id,
      )
    )
      fail('MODEL_INVALID_OUTPUT');
    ids.add(mapping.field_id);
    if (
      mapping.entity_id &&
      !input.entities.some((entity) => entity.entity_id === mapping.entity_id)
    )
      fail('MODEL_INVALID_OUTPUT');
    if (
      mapping.path &&
      mapping.entity_id &&
      !input.entities.some(
        (entity) =>
          entity.entity_id === mapping.entity_id &&
          mapping.path!.startsWith(entity.category + '.'),
      )
    )
      fail('MODEL_INVALID_OUTPUT');
  }
  return value;
}
function precisionOf(fact: PlanFact | null, answer: TaskAnswer | null) {
  return (
    answer?.precision ??
    (fact && typeof fact.value !== 'string' ? fact.value.precision : null)
  );
}
function equivalent(value: string) {
  const word = normalize(value);
  const groups = [
    ['本科', '学士', '学士学位', 'bachelor', 'bachelors'],
    ['硕士', '硕士学位', 'master', 'masters'],
    ['博士', '博士学位', 'phd', 'doctor'],
    ['男', '男性', 'male'],
    ['女', '女性', 'female'],
  ];
  return (
    groups.find((group) =>
      group.some((item) => normalize(item) === word),
    )?.[0] ?? word
  );
}
function sourceValue(value: PlanFact['value'] | FieldValue): FieldValue {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value.value === 'present'
      ? '至今'
      : value.value
    : value;
}
function targetValue(
  field: ScannedField,
  value: FieldValue,
  precision: string | null,
): { value: FieldValue; reason: string | null } {
  let target = value;
  if (field.control_type === 'file' || !field.supported)
    return { value: null, reason: 'CONTROL_MANUAL' };
  if (field.control_type === 'date' || field.control_type === 'month') {
    const required = field.control_type === 'date' ? 'day' : 'month';
    if (
      precision !== required ||
      typeof target !== 'string' ||
      !validDate({ value: target, precision: required })
    )
      return { value: null, reason: 'DATE_PRECISION_REQUIRED' };
  }
  if (field.control_type === 'select' || field.control_type === 'radio') {
    const choices = Array.isArray(target) ? target : [target];
    if (choices.some((item) => typeof item !== 'string'))
      return { value: null, reason: 'OPTION_NOT_FOUND' };
    const mapped: string[] = [];
    for (const choice of choices) {
      const options = field.options.filter(
        (option) =>
          !option.disabled &&
          (equivalent(option.label) === equivalent(String(choice)) ||
            option.value === choice),
      );
      if (options.length !== 1)
        return {
          value: null,
          reason: options.length ? 'OPTION_AMBIGUOUS' : 'OPTION_NOT_FOUND',
        };
      mapped.push(options[0]!.value);
    }
    if (field.constraints.multiple) target = [...new Set(mapped)];
    else if (mapped.length === 1) target = mapped[0]!;
    else return { value: null, reason: 'OPTION_AMBIGUOUS' };
  } else if (field.control_type === 'checkbox') {
    if (typeof target !== 'boolean')
      return { value: null, reason: 'BOOLEAN_REQUIRED' };
  } else if (typeof target !== 'string')
    return { value: null, reason: 'VALUE_TYPE_MISMATCH' };
  if (typeof target === 'string') {
    if (field.required && !target.trim())
      return { value: null, reason: 'VALUE_REQUIRED' };
    if (
      (field.constraints.min_length !== null &&
        target.length < field.constraints.min_length) ||
      (field.constraints.max_length !== null &&
        target.length > field.constraints.max_length)
    )
      return { value: null, reason: 'LENGTH_CONSTRAINT' };
    if (
      field.control_type === 'email' &&
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)
    )
      return { value: null, reason: 'VALUE_FORMAT' };
    if (
      ['date', 'month'].includes(field.control_type) &&
      ((field.constraints.min && target < field.constraints.min) ||
        (field.constraints.max && target > field.constraints.max))
    )
      return { value: null, reason: 'RANGE_CONSTRAINT' };
    if (field.control_type === 'number') {
      const n = Number(target);
      const c = field.constraints;
      if (
        !target.trim() ||
        !Number.isFinite(n) ||
        (c.min !== null && n < Number(c.min)) ||
        (c.max !== null && n > Number(c.max))
      )
        return { value: null, reason: 'RANGE_CONSTRAINT' };
      if (c.step && c.step !== 'any') {
        const step = Number(c.step),
          base = Number(c.min ?? 0),
          ratio = (n - base) / step;
        if (!(step > 0) || Math.abs(ratio - Math.round(ratio)) > 1e-8)
          return { value: null, reason: 'STEP_CONSTRAINT' };
      }
    }
    if (field.constraints.pattern) {
      const pattern = field.constraints.pattern;
      if (pattern === '.+@.+') {
        if (!/^[^@\s]+@[^@\s]+$/.test(target))
          return { value: null, reason: 'VALUE_FORMAT' };
      } else if (pattern === '[0-9+ -]{6,20}') {
        if (!/^[0-9+ -]{6,20}$/.test(target))
          return { value: null, reason: 'VALUE_FORMAT' };
      } else return { value: null, reason: 'PATTERN_REQUIRES_REVIEW' };
    }
  }
  return { value: target, reason: null };
}
const hasValue = (value: FieldValue) =>
  Array.isArray(value)
    ? value.length > 0
    : typeof value === 'boolean'
      ? value
      : typeof value === 'string'
        ? value.trim().length > 0
        : false;
function questionKey(
  path: FactPath | null,
  field: ScannedField,
  group: string,
  kind: PlanQuestion['kind'],
) {
  const scope =
    path && ['basic', 'intention'].includes(path.split('.')[0]!)
      ? 'global'
      : group;
  return canonicalJson([
    kind,
    path ?? field.field_id,
    scope,
    field.control_type,
    field.options.map((option) => option.label),
    field.constraints,
  ]);
}
function question(
  ctx: PlanningContext,
  questions: PlanQuestion[],
  field: ScannedField,
  path: FactPath | null,
  group_id: string,
  kind: PlanQuestion['kind'] = 'value',
  category: Category | null = null,
  entityOptions?: PlanQuestion['options'],
) {
  const key =
    kind === 'entity'
      ? 'entity:' + keyFor(group_id, category!)
      : questionKey(path, field, group_id, kind);
  let q = questions.find((item) => item.semantic_key === key);
  if (q) {
    if (!q.field_ids.includes(field.field_id)) q.field_ids.push(field.field_id);
    const catalog = ctx.question_catalog.find(
      (item) => item.question_id === q!.question_id,
    );
    if (catalog) catalog.field_ids = [...q.field_ids];
    return q;
  }
  const previous = ctx.question_catalog.find(
    (item) => item.semantic_key === key,
  );
  const type =
    kind !== 'value'
      ? 'single'
      : field.control_type === 'checkbox'
        ? 'boolean'
        : field.control_type === 'date'
          ? 'date'
          : field.control_type === 'month'
            ? 'month'
            : field.control_type === 'select' || field.control_type === 'radio'
              ? field.constraints.multiple
                ? 'multiple'
                : 'single'
              : 'text';
  const options =
    kind === 'entity'
      ? (entityOptions ?? [])
      : kind === 'mapping'
        ? PATHS.map((path) => ({ value: path, label: labels[path] ?? path }))
        : field.options
            .filter((option) => !option.disabled)
            .map((option) => ({
              value: option.label || option.value,
              label: option.label || option.value,
            }));
  q = {
    question_id: previous?.question_id ?? crypto.randomUUID(),
    semantic_key: key,
    field_ids: [field.field_id],
    kind,
    semantic_path: path,
    group_id,
    category,
    prompt:
      kind === 'entity'
        ? '请选择这组字段对应的经历；不确定时请保留人工处理'
        : kind === 'mapping'
          ? '请核对“' + (field.manual_label || field.label) + '”的业务含义'
          : '请补充' +
            (path
              ? (labels[path] ?? field.manual_label ?? field.label)
              : field.manual_label || field.label),
    answer_type: type,
    options,
    required: field.required,
    current_answer: null,
    source: 'user',
    scope: 'task',
  };
  const answer = ctx.answers.find((answer) => answer.semantic_key === key);
  if (answer) q.current_answer = answer.value;
  questions.push(q);
  if (!previous) ctx.question_catalog.push(structuredClone(q));
  else {
    previous.field_ids = [...new Set([...previous.field_ids, ...q.field_ids])];
  }
  return q;
}
export async function buildFillPlan(
  ctx: PlanningContext,
  metadata: {
    plan_id: string;
    plan_revision: number;
    expires_at: number;
    usage: { input_tokens: number; output_tokens: number };
    duration_ms: number;
  },
): Promise<FillPlan> {
  const input = ctx.input;
  validatePlanningInput(input);
  const fields = input.form_snapshot.fields;
  const paths = new Map<string, FactPath | null>();
  for (const field of fields)
    paths.set(
      field.field_id,
      own(ctx.semantic_overrides, field.field_id) ??
        semanticPath(input, field) ??
        ctx.mappings.mappings.find(
          (mapping) => mapping.field_id === field.field_id,
        )?.path ??
        null,
    );
  const bindings: EntityBinding[] = [];
  const bindingCandidates = new Map<
    string,
    { group_id: string; category: Category }
  >();
  for (const field of fields) {
    const path = paths.get(field.field_id);
    const category = path?.split('.')[0];
    if (category && experience.has(category)) {
      const group_id = bindingGroup(input, field, category);
      bindingCandidates.set(keyFor(group_id, category), { group_id, category });
    }
  }
  const pool = [...input.entities, ...ctx.task_entities];
  for (const { group_id, category } of bindingCandidates.values()) {
    const explicit = ctx.bindings.find(
      (binding) =>
        binding.group_id === group_id && binding.category === category,
    );
    if (explicit) {
      if (
        !pool.some(
          (entity) =>
            entity.entity_id === explicit.entity_id &&
            entity.category === category,
        )
      )
        fail('SCOPE_DENIED');
      bindings.push(explicit);
      continue;
    }
    const choices = pool.filter((entity) => entity.category === category);
    const groups = [...bindingCandidates.values()].filter(
      (group) => group.category === category,
    );
    const label =
      input.form_snapshot.groups.find((group) => group.group_id === group_id)
        ?.label ?? '';
    const exact = choices.filter((entity) =>
      [
        entity.label,
        ...input.confirmed_facts
          .filter(
            (fact) =>
              fact.entity_id === entity.entity_id &&
              /\.(company|school|name)$/.test(fact.path),
          )
          .map((fact) => sourceValue(fact.value)),
      ].some(
        (value) =>
          typeof value === 'string' &&
          normalize(value).length > 1 &&
          normalize(label).includes(normalize(value)),
      ),
    );
    const chosen =
      exact.length === 1
        ? exact[0]
        : choices.length === 1 && groups.length === 1
          ? choices[0]
          : null;
    if (chosen)
      bindings.push({
        group_id,
        category,
        entity_id: chosen.entity_id,
        source: 'rule',
      });
  }
  const questions: PlanQuestion[] = [];
  const decisions: FieldDecision[] = [];
  for (const field of fields) {
    let path = paths.get(field.field_id) ?? null;
    const rulePath = semanticPath(input, field);
    const mapping = ctx.mappings.mappings.find(
      (mapping) => mapping.field_id === field.field_id,
    );
    const category = path?.split('.')[0] ?? null;
    const group =
      category && experience.has(category)
        ? bindingGroup(input, field, category)
        : field.group_id;
    const d: FieldDecision = {
      field_id: field.field_id,
      field_label:
        field.manual_label || field.label || field.name || '未命名字段',
      group_id: field.group_id,
      entity_group_id: group,
      semantic_path: path,
      decision: 'skip',
      current_value: structuredClone(field.current_value),
      target_value: null,
      candidate_value: null,
      fact_refs: [],
      answer_refs: [],
      evidence_ids: [],
      entity_id: null,
      reason_code: 'OPTIONAL_EMPTY',
      replacement_confirmed: false,
      value_precision: null,
    };
    decisions.push(d);
    const label = [
      field.manual_label || field.label,
      field.name,
      field.description,
    ].join(' ');
    const mode = own(ctx.modes, field.field_id);
    if (
      forbidden.test(label) ||
      ['password', 'hidden', 'submit', 'button', 'reset', 'image'].includes(
        field.control_type,
      ) ||
      /搜索|search|keyword/i.test(label)
    ) {
      d.reason_code = 'PROHIBITED_OR_IRRELEVANT';
      continue;
    }
    if (mode === 'cancel' || mode === 'keep') {
      d.reason_code = mode === 'keep' ? 'USER_KEEP_EXISTING' : 'USER_CANCELLED';
      continue;
    }
    if (
      !field.supported ||
      !field.enabled ||
      field.read_only ||
      mode === 'manual' ||
      field.control_type === 'file' ||
      (consentField.test(label) && field.control_type === 'checkbox')
    ) {
      d.decision = 'manual';
      d.reason_code = mode === 'manual' ? 'USER_MANUAL' : 'CONTROL_MANUAL';
      continue;
    }
    if (thirdParty.test(label)) {
      path = null;
      d.semantic_path = null;
    }
    const override = own(ctx.semantic_overrides, field.field_id);
    if (rulePath && mapping?.path && mapping.path !== rulePath && !override) {
      d.decision = 'review';
      d.reason_code = 'SEMANTIC_CONFLICT';
      continue;
    }
    if (!rulePath && path && !override && !own(ctx.edited, field.field_id)) {
      d.decision = 'review';
      d.reason_code = 'MODEL_MAPPING_REQUIRES_REVIEW';
      question(ctx, questions, field, path, group, 'mapping', category);
      continue;
    }
    let binding: EntityBinding | undefined;
    if (category && experience.has(category)) {
      binding = bindings.find(
        (binding) =>
          binding.group_id === group && binding.category === category,
      );
      if (!binding) {
        d.decision = 'review';
        d.reason_code = 'ENTITY_BINDING_REQUIRED';
        question(ctx, questions, field, path, group, 'entity', category, [
          ...pool
            .filter((entity) => entity.category === category)
            .map((entity) => ({
              value: entity.entity_id,
              label: entity.label,
            })),
          { value: 'new-task-entity', label: '本任务新增一段经历' },
        ]);
        continue;
      }
      d.entity_id = binding.entity_id;
    }
    const qKey = questionKey(path, field, group, 'value');
    const answer =
      own(ctx.edited, field.field_id) ??
      ctx.answers.find(
        (answer) =>
          answer.semantic_key === qKey &&
          answer.field_ids.includes(field.field_id),
      ) ??
      null;
    const matching = path
      ? input.confirmed_facts.filter(
          (fact) =>
            fact.path === path &&
            (!binding || fact.entity_id === binding.entity_id),
        )
      : [];
    if (
      !answer &&
      matching.length > 1 &&
      new Set(matching.map((fact) => canonicalJson(fact.value))).size > 1
    ) {
      d.decision = 'review';
      d.reason_code = 'FACT_CONFLICT';
      continue;
    }
    const fact = matching[0] ?? null;
    if (!answer && !fact) {
      if (field.required) {
        d.decision = 'ask';
        d.reason_code = 'MISSING_FACT';
        question(ctx, questions, field, path, group);
      }
      continue;
    }
    if (answer && answer.value === null) fail('RULE_VIOLATION');
    const raw = answer ? answer.value : sourceValue(fact!.value);
    const precision = precisionOf(fact, answer);
    const target = targetValue(field, raw, precision);
    d.value_precision = precision as FieldDecision['value_precision'];
    d.fact_refs = answer
      ? []
      : matching.map((fact) => ({
          fact_id: fact.fact_id,
          fact_revision: fact.fact_revision,
        }));
    d.answer_refs = answer ? [answer.answer_id] : [];
    d.evidence_ids = answer
      ? []
      : [...new Set(matching.flatMap((fact) => fact.evidence_ids))];
    d.entity_id = d.entity_id ?? fact?.entity_id ?? null;
    if (target.reason) {
      d.decision =
        target.reason === 'DATE_PRECISION_REQUIRED' ? 'ask' : 'review';
      d.reason_code = target.reason;
      d.candidate_value = raw;
      if (d.decision === 'ask') question(ctx, questions, field, path, group);
      continue;
    }
    d.candidate_value = target.value;
    if (
      hasValue(field.current_value) &&
      canonicalJson(field.current_value) === canonicalJson(target.value)
    ) {
      d.reason_code = 'ALREADY_MATCHES';
      continue;
    }
    if (
      hasValue(field.current_value) &&
      canonicalJson(field.current_value) !== canonicalJson(target.value)
    ) {
      const replacement = own(ctx.replacement_values, field.field_id);
      if (
        mode !== 'replace' ||
        replacement === undefined ||
        canonicalJson(replacement) !== canonicalJson(target.value)
      ) {
        d.decision = 'review';
        d.reason_code = 'CURRENT_VALUE_CONFLICT';
        continue;
      }
      d.replacement_confirmed = true;
    }
    if (ctx.model_error && !answer) {
      d.decision = 'review';
      d.reason_code = 'MODEL_DEGRADED';
      continue;
    }
    d.decision = 'fill';
    d.reason_code = answer ? 'USER_TASK_ANSWER' : 'CONFIRMED_FACT';
    d.target_value = target.value;
  }
  // 仅同一绑定单元内核验时间，不将不同经历的时间重叠判错。
  for (const binding of bindings) {
    const dates = decisions.filter(
      (d) =>
        d.entity_group_id === binding.group_id &&
        d.entity_id === binding.entity_id,
    );
    for (const start of dates.filter((d) =>
      d.semantic_path?.endsWith('.start_date'),
    )) {
      for (const end of dates.filter((d) =>
        d.semantic_path?.endsWith('.end_date'),
      )) {
        const a = start?.candidate_value,
          b = end?.candidate_value;
        if (
          typeof a === 'string' &&
          typeof b === 'string' &&
          start?.value_precision &&
          end?.value_precision &&
          end.value_precision !== 'present'
        ) {
          const lower = (value: string) =>
            value.length === 4
              ? value + '-01-01'
              : value.length === 7
                ? value + '-01'
                : value;
          const upper = (value: string) =>
            value.length === 4
              ? value + '-12-31'
              : value.length === 7
                ? value + '-31'
                : value;
          if (lower(a) > upper(b)) {
            for (const date of [start, end]) {
              date.decision = 'review';
              date.reason_code = 'TIME_RANGE_ERROR';
              date.target_value = null;
            }
          }
        }
      }
    }
  }
  const plan: FillPlan = {
    schema_version: 1,
    ...metadata,
    task_id: input.task_id,
    profile_revision: input.profile_revision,
    snapshot_ref: snapshotRef(input.form_snapshot),
    form_snapshot_id: input.form_snapshot.form_snapshot_id,
    dom_fingerprint: input.form_snapshot.dom_fingerprint,
    field_decisions: decisions,
    questions,
    task_answers: [...ctx.answers, ...Object.values(ctx.edited)],
    entity_bindings: bindings,
    degraded: !!ctx.model_error,
    degraded_reason: ctx.model_error,
    plan_digest: '0'.repeat(64),
    created_at: Date.now(),
    application_submitted: false,
  };
  plan.plan_digest = await hashJson(digestiblePlan(plan));
  return plan;
}
export function resolveContext(
  context: PlanningContext,
  plan: FillPlan,
  request: ResolveRequest,
) {
  const ctx = structuredClone(context);
  const fields = ctx.input.form_snapshot.fields;
  const ids = new Set(fields.map((field) => field.field_id));
  const duplicate = new Set<string>();
  for (const answer of request.answers) {
    if (duplicate.has(answer.question_id)) fail('RULE_VIOLATION');
    duplicate.add(answer.question_id);
    const q = ctx.question_catalog.find(
      (q) => q.question_id === answer.question_id,
    );
    if (!q || !q.field_ids.every((id) => ids.has(id)))
      fail('REFERENCE_NOT_FOUND');
    if (q.kind === 'entity') {
      if (typeof answer.value !== 'string' || !q.category)
        fail('RULE_VIOLATION');
      let entity_id = answer.value;
      if (entity_id === 'new-task-entity') {
        entity_id = crypto.randomUUID();
        ctx.task_entities.push({
          entity_id,
          category: q.category,
          label: '本任务新增' + q.category,
        });
      }
      if (
        ![...ctx.input.entities, ...ctx.task_entities].some(
          (entity) =>
            entity.entity_id === entity_id && entity.category === q.category,
        )
      )
        fail('SCOPE_DENIED');
      ctx.bindings = ctx.bindings.filter(
        (b) => !(b.group_id === q.group_id && b.category === q.category),
      );
      ctx.bindings.push({
        group_id: q.group_id,
        category: q.category,
        entity_id,
        source: 'user',
      });
      continue;
    }
    if (q.kind === 'mapping') {
      if (
        typeof answer.value !== 'string' ||
        !(PATHS as readonly string[]).includes(answer.value)
      )
        fail('RULE_VIOLATION');
      for (const id of q.field_ids)
        ctx.semantic_overrides[id] = answer.value as FactPath;
      continue;
    }
    if (answer.value === null) fail('RULE_VIOLATION');
    const previous = ctx.answers.find((a) => a.semantic_key === q.semantic_key);
    const next: TaskAnswer = {
      answer_id: crypto.randomUUID(),
      question_id: q.question_id,
      semantic_key: q.semantic_key,
      field_ids: q.field_ids,
      value: structuredClone(answer.value),
      precision: answer.precision,
      scope: 'task',
      source: 'user',
      revision: (previous?.revision ?? 0) + 1,
    };
    for (const id of q.field_ids) {
      const field = fields.find((field) => field.field_id === id)!;
      const target = targetValue(field, next.value, next.precision);
      if (target.reason) fail('RULE_VIOLATION');
    }
    ctx.answers = ctx.answers.filter((a) => a.semantic_key !== q.semantic_key);
    ctx.answers.push(next);
  }
  const resolutionKeys = new Set<string>();
  for (const action of request.resolutions) {
    const key =
      action.type === 'bind_entity'
        ? 'entity:' + action.group_id + ':' + action.category
        : 'field:' + action.field_id;
    if (resolutionKeys.has(key)) fail('RULE_VIOLATION');
    resolutionKeys.add(key);
    if (action.type === 'bind_entity') {
      if (
        !ctx.input.form_snapshot.groups.some(
          (g) => g.group_id === action.group_id,
        ) ||
        ![...ctx.input.entities, ...ctx.task_entities].some(
          (e) =>
            e.entity_id === action.entity_id && e.category === action.category,
        )
      )
        fail('SCOPE_DENIED');
      ctx.bindings = ctx.bindings.filter(
        (b) =>
          !(b.group_id === action.group_id && b.category === action.category),
      );
      ctx.bindings.push({
        group_id: action.group_id,
        category: action.category,
        entity_id: action.entity_id,
        source: 'user',
      });
      continue;
    }
    if (!ids.has(action.field_id)) fail('REFERENCE_NOT_FOUND');
    const field = fields.find((f) => f.field_id === action.field_id)!;
    if (action.type === 'map_field') {
      const known = semanticPath(ctx.input, field);
      if (known && known !== action.path) fail('RULE_VIOLATION');
      ctx.semantic_overrides[action.field_id] = action.path;
      continue;
    }
    if (action.type === 'edit') {
      const target = targetValue(field, action.value, action.precision);
      if (
        target.reason ||
        action.value === null ||
        forbidden.test(field.label) ||
        (consentField.test(field.label) && field.control_type === 'checkbox')
      )
        fail('RULE_VIOLATION');
      const old = own(ctx.edited, action.field_id);
      ctx.edited[action.field_id] = {
        answer_id: crypto.randomUUID(),
        question_id: crypto.randomUUID(),
        semantic_key: 'edit:' + action.field_id,
        field_ids: [action.field_id],
        value: structuredClone(action.value),
        precision: action.precision,
        scope: 'task',
        source: 'user',
        revision: (old?.revision ?? 0) + 1,
      };
      delete ctx.modes[action.field_id];
      delete ctx.replacement_values[action.field_id];
      continue;
    }
    if (action.type === 'replace') {
      const decision = plan.field_decisions.find(
        (d) => d.field_id === action.field_id,
      );
      if (
        !decision ||
        decision.reason_code !== 'CURRENT_VALUE_CONFLICT' ||
        decision.candidate_value === null
      )
        fail('RULE_VIOLATION');
      ctx.replacement_values[action.field_id] = structuredClone(
        decision.candidate_value,
      );
    }
    ctx.modes[action.field_id] = action.type;
  }
  return ctx;
}
