import { Value } from '@sinclair/typebox/value';
import {
  OpenAnswerInputSchema,
  AnswerModelOutputSchema,
  AnswerDraftSchema,
  AnswerResultSchema,
  canonicalJson,
  hashJson,
  type AnswerInput,
  type AnswerModelOutput,
  type AnswerResult,
  type AnswerRequest,
  type AnswerDraft,
  type CareerState,
  type JobDocument,
  type ResumeFact,
  type FactPath,
} from '@formpilot/contracts';
import {
  confirmedFacts,
  displayValue,
  validDate,
  validateFactValue,
  type ProfileState,
} from './index';
import { resumeCategoryNames, resumeFactLabels, resumeValue } from './resume';
export const ANSWER_ENGINE_VERSION = 'evidence-answer-0.1.0';
const excluded = new Set<FactPath>([
  'basic.name',
  'basic.gender',
  'basic.phone',
  'basic.email',
  'basic.current_city',
  'certificate.number',
  'intention.salary',
]);
const unique = (ids: string[]) => new Set(ids).size === ids.length;
function fail(message: string): never {
  throw new Error(message);
}
export function eligibleAnswerFacts(profile: ProfileState) {
  return confirmedFacts(profile).filter((f) => !excluded.has(f.path));
}
export function validateAnswerInput(
  input: unknown,
): asserts input is AnswerInput {
  if (
    !Value.Check(OpenAnswerInputSchema, input) ||
    !input.question.trim() ||
    !unique(input.facts.map((f) => f.fact_id)) ||
    !unique(input.job.requirements.map((r) => r.requirement_id)) ||
    input.facts.some((f) => excluded.has(f.path)) ||
    JSON.stringify(input).length > 120000
  )
    fail('开放题输入无效，请检查问题与选中事实');
  const categories = new Map<string, string>();
  for (const f of input.facts) {
    validateFactValue(f.path, f.value);
    const category = f.path.split('.')[0]!;
    if (categories.has(f.entity_id) && categories.get(f.entity_id) !== category)
      fail('开放题经历实体分类不一致');
    categories.set(f.entity_id, category);
  }
}
export function makeAnswerInput(
  job: JobDocument,
  profile: ProfileState,
  question: string,
  selected: string[],
) {
  if (!job.reviewed || !job.requirements.length) fail('请先核对岗位要求');
  if (!selected.length || selected.length > 16 || !unique(selected))
    fail('请选中 1～16 条已确认事实');
  const allowed = eligibleAnswerFacts(profile);
  const snapshots: ResumeFact[] = selected.map((id) => {
    const f = allowed.find((f) => f.fact_id === id);
    if (!f) fail('选中的事实未确认、存在冲突或不适合发送，请重新选择');
    if (f.evidence_ids.length > 20) fail('事实引用过多，请先整理资料');
    return {
      fact_id: f.fact_id,
      fact_revision: f.fact_revision,
      entity_id: f.entity_id,
      category: f.category,
      path: f.path,
      value: structuredClone(f.value),
      source_type: f.source_type,
      relevance: [],
      evidences: f.evidence_ids.map((id) => {
        const e = profile.evidences.find((e) => e.evidence_id === id);
        if (!e) fail('事实证据已失效');
        return {
          evidence_id: e.evidence_id,
          document_id: e.document_id,
          block_id: e.block_id,
          page: e.page,
          quote: e.quote,
          start: e.start,
          end: e.end,
        };
      }),
    };
  });
  const input: AnswerInput = {
    question: question.trim(),
    profile_revision: profile.profile_revision,
    job: {
      job_id: job.job_id,
      revision: job.revision,
      source_hash: job.source_hash,
      title: job.attributes.find((a) => a.key === 'title')?.value ?? '',
      company: job.attributes.find((a) => a.key === 'company')?.value ?? '',
      requirements: job.requirements.map((r) => ({
        requirement_id: r.requirement_id,
        quote: r.quote,
      })),
    },
    facts: snapshots.map(
      ({ fact_id, fact_revision, entity_id, path, value }) => ({
        fact_id,
        fact_revision,
        entity_id,
        path,
        value,
      }),
    ),
  };
  validateAnswerInput(input);
  return { input, facts: snapshots };
}
export function renderAnswer(input: AnswerInput, selection: AnswerModelOutput) {
  validateAnswerInput(input);
  if (
    !Value.Check(AnswerModelOutputSchema, selection) ||
    !selection.citations.length ||
    !unique(selection.citations.map((c) => c.fact_id))
  )
    fail('MODEL_INVALID_OUTPUT');
  const groups = new Map<string, { category: string; lines: string[] }>();
  for (const cite of selection.citations) {
    const f = input.facts.find((f) => f.fact_id === cite.fact_id);
    if (
      !f ||
      cite.quote !== displayValue(f.value) ||
      !unique(cite.requirement_ids) ||
      cite.requirement_ids.some(
        (id) => !input.job.requirements.some((r) => r.requirement_id === id),
      )
    )
      fail('EVIDENCE_INVALID');
    let group = groups.get(f.entity_id);
    if (!group) {
      group = { category: f.path.split('.')[0]!, lines: [] };
      groups.set(f.entity_id, group);
    }
    // Values are copied whole, including negations, limits and original date precision.
    const v =
      typeof f.value !== 'string' && f.value.precision === 'present'
        ? '至今'
        : displayValue(f.value);
    group.lines.push(resumeFactLabels[f.path] + '为：' + v);
  }
  const intros = {
    strength: '我可以结合以下相关经历说明自己的背景：',
    motivation: '我可以将岗位要求与以下个人经历对照，进一步说明申请动机：',
    challenge:
      '与这道问题相关的经历材料如下，具体挑战和处理过程需要结合真实情况说明：',
    experience: '我的相关经历包括：',
    general: '针对这道问题，可以结合以下个人经历作答：',
  };
  const text =
    intros[selection.focus] +
    '\n\n' +
    [...groups.values()]
      .map(
        (g) =>
          '关于我的' +
          (resumeCategoryNames[g.category] ?? '相关经历') +
          '，' +
          g.lines.join('；') +
          '。',
      )
      .join('\n\n');
  if (text.length > 6000) fail('MODEL_INVALID_OUTPUT');
  return text;
}
export async function validateAnswerModel(
  input: AnswerInput,
  output: unknown,
  meta: Pick<AnswerResult, 'provider' | 'model' | 'usage' | 'duration_ms'>,
): Promise<AnswerResult> {
  const generated_text = renderAnswer(input, output as AnswerModelOutput);
  return {
    input_hash: await hashJson(input),
    selection: output as AnswerModelOutput,
    generated_text,
    ...meta,
  };
}
export function validateAnswerSnapshots(
  input: AnswerInput,
  facts: ResumeFact[],
  profile?: ProfileState,
  current = false,
) {
  if (
    facts.length !== input.facts.length ||
    !unique(facts.map((f) => f.fact_id))
  )
    fail('答案事实快照无效');
  for (const item of facts) {
    const f = input.facts.find((f) => f.fact_id === item.fact_id);
    if (
      !f ||
      f.fact_revision !== item.fact_revision ||
      f.entity_id !== item.entity_id ||
      f.path !== item.path ||
      item.category !== f.path.split('.')[0] ||
      canonicalJson(f.value) !== canonicalJson(item.value)
    )
      fail('答案内容与选中事实不一致');
    if (!profile) continue;
    const source = (
      current
        ? eligibleAnswerFacts(profile)
        : profile.facts.filter((f) => f.confirmation === 'confirmed')
    ).find(
      (f) =>
        f.fact_id === item.fact_id && f.fact_revision === item.fact_revision,
    );
    if (
      !source ||
      source.path !== item.path ||
      source.entity_id !== item.entity_id ||
      source.source_type !== item.source_type ||
      canonicalJson(source.value) !== canonicalJson(item.value) ||
      canonicalJson([...source.evidence_ids].sort()) !==
        canonicalJson(item.evidences.map((e) => e.evidence_id).sort())
    )
      fail('答案来源事实已失效');
    for (const e of item.evidences) {
      const original = profile.evidences.find(
        (x) => x.evidence_id === e.evidence_id,
      );
      if (
        !original ||
        ['document_id', 'block_id', 'page', 'quote', 'start', 'end'].some(
          (k) =>
            original[k as keyof typeof original] !== e[k as keyof typeof e],
        )
      )
        fail('答案原文证据已失效');
    }
  }
}
export function validateAnswerDraft(
  value: unknown,
): asserts value is AnswerDraft {
  if (!Value.Check(AnswerDraftSchema, value)) fail('开放题草稿格式无效');
  validateAnswerInput(value.input);
  if (
    value.consent.provider !== value.result.provider ||
    value.consent.model !== value.result.model ||
    value.consent.payload_hash !== value.result.input_hash
  )
    fail('答案授权与生成结果不一致');
  validateAnswerSnapshots(value.input, value.facts);
  if (
    renderAnswer(value.input, value.result.selection) !==
    value.result.generated_text
  )
    fail('生成答案偏离原始事实');
  if (!validDate({ value: value.as_of, precision: 'day' }))
    fail('答案计算日期无效');
  let previous = 0;
  for (const version of [...value.history, value]) {
    if (
      !version.text.trim() ||
      version.user_edited !==
        (version.text.trim() !== value.result.generated_text.trim()) ||
      (version.status === 'approved') !== (version.approved_at !== null) ||
      (version.status === 'approved' && !version.user_edited) ||
      version.revision <= previous
    )
      fail('答案修订或审核状态无效');
    previous = version.revision;
  }
}
export async function acceptAnswer(
  input: AnswerInput,
  facts: ResumeFact[],
  result: AnswerResult,
  consent: AnswerRequest['consent'],
): Promise<AnswerDraft> {
  if (
    !Value.Check(AnswerResultSchema, result) ||
    result.input_hash !== (await hashJson(input)) ||
    renderAnswer(input, result.selection) !== result.generated_text
  )
    fail('答案响应与本次输入不一致');
  const now = Date.now();
  const draft: AnswerDraft = {
    schema_version: 1,
    answer_id: crypto.randomUUID(),
    input: structuredClone(input),
    result: structuredClone(result),
    facts: structuredClone(facts),
    consent: structuredClone(consent),
    engine_version: ANSWER_ENGINE_VERSION,
    as_of: new Date().toISOString().slice(0, 10),
    revision: 1,
    created_at: now,
    updated_at: now,
    text: result.generated_text,
    user_edited: false,
    status: 'draft',
    approved_at: null,
    history: [],
  };
  validateAnswerDraft(draft);
  return draft;
}
export function isAnswerCurrent(
  answer: AnswerDraft,
  job: JobDocument | null | undefined,
  profile: ProfileState,
  day = new Date().toISOString().slice(0, 10),
) {
  return (
    !!job?.reviewed &&
    job.job_id === answer.input.job.job_id &&
    job.revision === answer.input.job.revision &&
    job.source_hash === answer.input.job.source_hash &&
    profile.profile_revision === answer.input.profile_revision &&
    answer.engine_version === ANSWER_ENGINE_VERSION &&
    answer.as_of === day
  );
}
function assertCurrent(
  answer: AnswerDraft,
  job: JobDocument,
  profile: ProfileState,
) {
  validateAnswerDraft(answer);
  if (!isAnswerCurrent(answer, job, profile))
    fail('岗位或资料已变化，请根据最新资料重新授权生成');
  const current = makeAnswerInput(
    job,
    profile,
    answer.input.question,
    answer.input.facts.map((f) => f.fact_id),
  );
  if (canonicalJson(current.input) !== canonicalJson(answer.input))
    fail('答案输入已变化');
  validateAnswerSnapshots(answer.input, answer.facts, profile, true);
}
export function reviseAnswer(
  answer: AnswerDraft,
  change: { text?: string; approve?: boolean; restore_revision?: number },
  job: JobDocument,
  profile: ProfileState,
): AnswerDraft {
  assertCurrent(answer, job, profile);
  if (
    Object.keys(change).length !== 1 ||
    Object.keys(change).some(
      (k) => !['text', 'approve', 'restore_revision'].includes(k),
    )
  )
    fail('请将答案修改和审核分开进行');
  const next = structuredClone(answer);
  next.history = [
    ...next.history,
    {
      revision: answer.revision,
      updated_at: answer.updated_at,
      text: answer.text,
      user_edited: answer.user_edited,
      status: answer.status,
      approved_at: answer.approved_at,
    },
  ].slice(-10);
  next.revision++;
  next.updated_at = Date.now();
  next.status = 'draft';
  next.approved_at = null;
  if (change.text !== undefined) next.text = change.text.trim();
  if (change.restore_revision !== undefined) {
    const old = answer.history.find(
      (h) => h.revision === change.restore_revision,
    );
    if (!old) fail('答案历史版本已不在保留范围');
    next.text = old.text;
  }
  next.user_edited = next.text.trim() !== next.result.generated_text.trim();
  if (change.approve) {
    if (!next.user_edited) fail('请先结合真实情况修改草稿并保存，再审核使用');
    next.status = 'approved';
    next.approved_at = next.updated_at;
  }
  validateAnswerDraft(next);
  return next;
}
const basis = (a: AnswerDraft) => ({
  ...a,
  text: '',
  user_edited: false,
  status: '',
  approved_at: null,
  updated_at: 0,
  revision: 0,
  history: [],
});
export function putAnswer(
  state: CareerState,
  answer: AnswerDraft,
  expected: number | null = null,
): CareerState {
  validateAnswerDraft(answer);
  if (!state.jobs.some((j) => j.job_id === answer.input.job.job_id))
    fail('答案来源岗位已删除');
  const all = state.answers ?? [],
    old = all.find((a) => a.answer_id === answer.answer_id);
  if (expected === null ? !!old : old?.revision !== expected)
    fail('答案修订已变化，请重新读取');
  if (
    old &&
    (answer.revision !== old.revision + 1 ||
      canonicalJson(basis(old)) !== canonicalJson(basis(answer)))
  )
    fail('答案来源快照不能修改');
  if (
    !old &&
    (answer.revision !== 1 ||
      answer.history.length ||
      answer.status !== 'draft' ||
      answer.user_edited)
  )
    fail('新答案必须从原始待编辑草稿开始');
  if (!old && all.length >= 30)
    fail('最多保存 30 份开放题答案，请先删除不需要的草稿');
  return {
    ...state,
    revision: state.revision + 1,
    answers: [
      ...all.filter((a) => a.answer_id !== answer.answer_id),
      structuredClone(answer),
    ],
  };
}
export function exportAnswer(
  answer: AnswerDraft,
  job: JobDocument,
  profile: ProfileState,
) {
  assertCurrent(answer, job, profile);
  if (answer.status !== 'approved' || !answer.user_edited)
    fail('请先修改、保存并审核此答案');
  return answer.text + '\n';
}
export { resumeValue as answerFactValue };
