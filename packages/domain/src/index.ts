import type { LocalFillTask, CareerState } from '@formpilot/contracts';
export * from './planning';
import {
  PATHS,
  validateExtraction,
  type SourceBlock,
  type ParseRequest,
  type FactValue,
  type Candidate,
  type FactPath,
  type Category,
} from '@formpilot/contracts';
export interface Document {
  document_id: string;
  document_revision: 1;
  name: string;
  mime: string;
  content_hash: string;
  created_at: string;
  blocks: SourceBlock[];
  original_base64: string;
  status: 'imported' | 'running' | 'parsed' | 'failed';
  error: string | null;
  job_id: string | null;
  client_request_id: string | null;
  consent_hash: string | null;
  parse_consent: ParseRequest['consent'] | null;
}
export interface Evidence {
  evidence_id: string;
  document_id: string;
  document_revision: 1;
  block_id: string;
  page: number | null;
  quote: string;
  start: number;
  end: number;
}
export interface Entity {
  entity_id: string;
  category: Category;
  label: string;
}
export interface Fact {
  fact_id: string;
  fact_revision: number;
  profile_revision: number;
  created_at: string;
  category: Category;
  path: FactPath;
  value: FactValue;
  entity_id: string;
  confirmation: 'pending' | 'confirmed' | 'rejected';
  source_type: 'resume' | 'user';
  evidence_ids: string[];
  document_id: string | null;
  note: string;
}
export interface ProfileState {
  schema_version: 1;
  workspace_id: string;
  profile_revision: number;
  documents: Document[];
  entities: Entity[];
  evidences: Evidence[];
  facts: Fact[];
  fill_tasks?: LocalFillTask[];
  career?: CareerState;
  measurements: {
    document_id: string;
    provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    duration_ms: number;
  }[];
}
export function emptyProfile(workspace_id = crypto.randomUUID()): ProfileState {
  return {
    schema_version: 1,
    workspace_id,
    profile_revision: 0,
    documents: [],
    entities: [],
    evidences: [],
    facts: [],
    measurements: [],
  };
}
export function displayValue(value: FactValue): string {
  return typeof value === 'string' ? value : value.value;
}
export function validDate(value: FactValue): boolean {
  if (typeof value === 'string') return false;
  const v = value.value;
  if (value.precision === 'present') return v === 'present';
  if (value.precision === 'year')
    return /^\d{4}$/.test(v) && Number(v) >= 1900 && Number(v) <= 2200;
  if (value.precision === 'month')
    return (
      /^\d{4}-(0[1-9]|1[0-2])$/.test(v) &&
      Number(v.slice(0, 4)) >= 1900 &&
      Number(v.slice(0, 4)) <= 2200
    );
  if (value.precision === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const date = new Date(v + 'T00:00:00Z');
    return (
      !Number.isNaN(date.valueOf()) &&
      date.toISOString().slice(0, 10) === v &&
      Number(v.slice(0, 4)) >= 1900 &&
      Number(v.slice(0, 4)) <= 2200
    );
  }
  return false;
}
export function validateFactValue(path: string, value: FactValue) {
  if (path.endsWith('_date') || path === 'certificate.date') {
    if (!validDate(value)) throw new Error('日期精度或日期值无效');
  } else if (typeof value !== 'string' || !value.trim() || value.length > 3000)
    throw new Error('事实值必须是非空文本');
}
export function blocksFromPages(
  document_id: string,
  pages: { page: number | null; text: string }[],
): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  let total = 0;
  for (const page of pages) {
    if (!page.text.trim()) continue;
    total += page.text.length;
    if (total > 100000) throw new Error('文本超过 10 万字限制');
    for (let start = 0; start < page.text.length; start += 1200) {
      const text = page.text.slice(start, start + 1200);
      if (text.trim())
        blocks.push({
          block_id: crypto.randomUUID(),
          document_id,
          document_revision: 1,
          page: page.page,
          text,
          start,
          end: start + text.length,
        });
    }
  }
  if (!blocks.length)
    throw new Error('没有可提取文本；扫描 PDF 请改用 TXT 或手动输入');
  if (blocks.length > 200) throw new Error('文档分块数量超限');
  return blocks;
}
export function validateCandidates(
  document: Pick<Document, 'blocks' | 'document_id'>,
  input: unknown,
): Candidate[] {
  const { candidates } = validateExtraction(input);
  const ids = new Set(document.blocks.map((b) => b.block_id));
  for (const candidate of candidates) {
    if (!ids.has(candidate.block_id)) throw new Error('EVIDENCE_INVALID');
    const block = document.blocks.find(
      (b) => b.block_id === candidate.block_id,
    )!;
    if (!block.text.includes(candidate.quote))
      throw new Error('EVIDENCE_INVALID');
    if (!candidate.path.startsWith(candidate.category + '.'))
      throw new Error('RULE_VIOLATION');
    validateFactValue(candidate.path, candidate.value);
    // 证据必须同时包含事实值，日期允许中文年月及单数字月份，但不能补精度。
    const normalized = (s: string) =>
      s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    if (typeof candidate.value === 'string') {
      if (!normalized(candidate.quote).includes(normalized(candidate.value)))
        throw new Error('EVIDENCE_INVALID');
    } else {
      const { value, precision } = candidate.value;
      if (precision === 'present') {
        if (!/至今|现在|present|current/i.test(candidate.quote))
          throw new Error('EVIDENCE_INVALID');
      } else {
        const parts = value
          .split('-')
          .map((part) => (part.length === 2 ? '0?' + Number(part) : part));
        const pattern = new RegExp(
          '(^|[^0-9])' + parts.join('(?:[年/月.\\-]\\s*|\\s+)') + '(?![0-9])',
        );
        if (!pattern.test(candidate.quote)) throw new Error('EVIDENCE_INVALID');
      }
    }
  }
  return candidates;
}
export function currentFacts(profile: ProfileState): Fact[] {
  const map = new Map<string, Fact>();
  for (const f of profile.facts) {
    const prior = map.get(f.fact_id);
    if (!prior || prior.fact_revision < f.fact_revision) map.set(f.fact_id, f);
  }
  return [...map.values()];
}
export function importExtraction(
  profile: ProfileState,
  document_id: string,
  input: unknown,
): ProfileState {
  const next = structuredClone(profile);
  const doc = next.documents.find((d) => d.document_id === document_id);
  if (!doc) throw new Error('文档不存在');
  const candidates = validateCandidates(doc, input);
  if (next.facts.some((f) => f.document_id === document_id))
    throw new Error('此文档已解析，请导入新版本');
  next.profile_revision++;
  const entities = new Map<string, string>();
  for (const candidate of candidates) {
    const key =
      candidate.category +
      ':' +
      (['basic', 'intention'].includes(candidate.category)
        ? 'singleton'
        : candidate.entity_key);
    let entity_id = entities.get(key);
    if (!entity_id) {
      const singleton = ['basic', 'intention'].includes(candidate.category)
        ? next.entities.find((e) => e.category === candidate.category)
        : undefined;
      entity_id = singleton?.entity_id ?? crypto.randomUUID();
      entities.set(key, entity_id);
      if (!singleton)
        next.entities.push({
          entity_id,
          category: candidate.category,
          label: candidate.entity_key,
        });
    }
    const block = doc.blocks.find((b) => b.block_id === candidate.block_id)!;
    const start = block.text.indexOf(candidate.quote);
    const evidence_id = crypto.randomUUID();
    next.evidences.push({
      evidence_id,
      document_id,
      document_revision: 1,
      block_id: block.block_id,
      page: block.page,
      quote: candidate.quote,
      start,
      end: start + candidate.quote.length,
    });
    next.facts.push({
      fact_id: crypto.randomUUID(),
      fact_revision: 1,
      profile_revision: next.profile_revision,
      created_at: new Date().toISOString(),
      category: candidate.category,
      path: candidate.path,
      value: candidate.value,
      entity_id,
      confirmation: 'pending',
      source_type: 'resume',
      evidence_ids: [evidence_id],
      document_id,
      note: '',
    });
  }
  doc.status = 'parsed';
  doc.error = null;
  doc.job_id = null;
  return next;
}
export function factConflicts(profile: ProfileState, fact: Fact): Fact[] {
  return currentFacts(profile).filter(
    (other) =>
      other.fact_id !== fact.fact_id &&
      other.confirmation !== 'rejected' &&
      other.path === fact.path &&
      other.entity_id === fact.entity_id &&
      JSON.stringify(other.value) !== JSON.stringify(fact.value),
  );
}
export function anomalies(profile: ProfileState): string[] {
  const output: string[] = [];
  const facts = currentFacts(profile).filter(
    (f) => f.confirmation !== 'rejected',
  );
  for (const entity of profile.entities) {
    const dates = facts.filter((f) => f.entity_id === entity.entity_id);
    const start = dates.find((f) => f.path.endsWith('.start_date'));
    const end = dates.find((f) => f.path.endsWith('.end_date'));
    if (
      start &&
      end &&
      typeof start.value !== 'string' &&
      typeof end.value !== 'string' &&
      end.value.precision !== 'present'
    ) {
      const lower = (v: string) =>
        v.length === 4 ? v + '-01-01' : v.length === 7 ? v + '-01' : v;
      const upper = (v: string) =>
        v.length === 4 ? v + '-12-31' : v.length === 7 ? v + '-31' : v;
      if (lower(start.value.value) > upper(end.value.value))
        output.push(entity.label + '：结束时间早于开始时间');
    }
  }
  return output;
}
export function reviseFact(
  profile: ProfileState,
  id: string,
  change: Partial<Pick<Fact, 'value' | 'confirmation' | 'entity_id'>>,
): ProfileState {
  const current = currentFacts(profile).find((f) => f.fact_id === id);
  if (!current) throw new Error('事实不存在');
  const next = structuredClone(profile);
  const updated = {
    ...structuredClone(current),
    ...change,
    fact_revision: current.fact_revision + 1,
    profile_revision: profile.profile_revision + 1,
    created_at: new Date().toISOString(),
  };
  validateFactValue(updated.path, updated.value);
  if (
    !next.entities.some(
      (e) =>
        e.entity_id === updated.entity_id && e.category === updated.category,
    )
  )
    throw new Error('经历实体不存在或分类不匹配');
  if (JSON.stringify(updated.value) !== JSON.stringify(current.value)) {
    updated.source_type = 'user';
    updated.note = '用户修改；原证据仅供对照，不代表修改后的值来自原文';
    updated.confirmation = 'pending';
  }
  if (
    updated.confirmation === 'confirmed' &&
    factConflicts(next, updated).some((f) => f.confirmation === 'confirmed')
  )
    throw new Error('请先拒绝冲突事实，不能同时确认互相矛盾的值');
  next.profile_revision++;
  next.facts.push(updated);
  return next;
}
export function addManualFact(
  profile: ProfileState,
  path: FactPath,
  value: FactValue,
  entity_id: string | null,
): ProfileState {
  if (!PATHS.includes(path)) throw new Error('未知事实路径');
  validateFactValue(path, value);
  const next = structuredClone(profile);
  const category = path.split('.')[0] as Category;
  let entity = entity_id
    ? next.entities.find(
        (e) => e.entity_id === entity_id && e.category === category,
      )
    : next.entities.find(
        (e) =>
          e.category === category && ['basic', 'intention'].includes(category),
      );
  if (entity_id && !entity) throw new Error('经历实体分类不匹配');
  if (!entity) {
    entity = {
      entity_id: crypto.randomUUID(),
      category,
      label: category + '（手动）',
    };
    next.entities.push(entity);
  }
  next.profile_revision++;
  next.facts.push({
    fact_id: crypto.randomUUID(),
    fact_revision: 1,
    profile_revision: next.profile_revision,
    created_at: new Date().toISOString(),
    category,
    path,
    value,
    entity_id: entity.entity_id,
    confirmation: 'pending',
    source_type: 'user',
    evidence_ids: [],
    document_id: null,
    note: '手动录入，待确认',
  });
  return next;
}
// 已确认值始终排除未解决冲突；后续 M3 从该边界读取。
export function confirmedFacts(profile: ProfileState) {
  return currentFacts(profile).filter(
    (f) =>
      f.confirmation === 'confirmed' && factConflicts(profile, f).length === 0,
  );
}

export function mergeEntities(
  profile: ProfileState,
  from: string,
  to: string,
): ProfileState {
  const source = profile.entities.find((e) => e.entity_id === from),
    target = profile.entities.find((e) => e.entity_id === to);
  if (!source || !target || source.category !== target.category || from === to)
    throw new Error('只能映射到同类的其他经历');
  let next = structuredClone(profile);
  for (const f of currentFacts(next).filter((f) => f.entity_id === from))
    next = reviseFact(next, f.fact_id, {
      entity_id: to,
      confirmation: 'pending',
    });
  return next;
}
export * from './execution';
export * from './career';

export * from './resume';

export * from './answer';
