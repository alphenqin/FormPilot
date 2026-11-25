import { it, expect } from 'vitest';
import { hashJson } from '@formpilot/contracts';
import {
  answerFixture,
  answerSelection,
  answerConsent,
} from '../../../tests/fixtures/answer';
import {
  acceptAnswer,
  validateAnswerModel,
  renderAnswer,
  validateAnswerDraft,
  validateAnswerSnapshots,
  makeAnswerInput,
  eligibleAnswerFacts,
  reviseAnswer,
  exportAnswer,
  isAnswerCurrent,
  putAnswer,
} from './answer';
import { reviseFact } from './index';
import { emptyCareer, putCareerJob, reviseJob } from './career';
const meta = {
  provider: 'controlled',
  model: 'test',
  usage: { input_tokens: 1, output_tokens: 1 },
  duration_ms: 1,
};
async function fixture() {
  const f = await answerFixture();
  const result = await validateAnswerModel(
    f.input,
    answerSelection(f.input),
    meta,
  );
  return {
    ...f,
    result,
    draft: await acceptAnswer(
      f.input,
      f.facts,
      result,
      await answerConsent(f.input),
    ),
  };
}
it('只发送明确选中的确认事实，不发送联系方式、待确认资料和原文证据', async () => {
  const f = await answerFixture();
  expect(JSON.stringify(f.input)).not.toContain('PRIVATE_NAME_NOT_SENT');
  expect(JSON.stringify(f.input)).not.toContain('PENDING_NOT_SENT');
  expect(JSON.stringify(f.input)).not.toContain('evidences');
  expect(f.input.facts).toHaveLength(2);
  const pending = f.profile.facts.find((x) => x.value === 'PENDING_NOT_SENT')!;
  expect(() =>
    makeAnswerInput(f.job, f.profile, f.input.question, [pending.fact_id]),
  ).toThrow('未确认');
  const name = f.profile.facts.find(
    (x) => x.value === 'PRIVATE_NAME_NOT_SENT',
  )!;
  expect(() =>
    makeAnswerInput(f.job, f.profile, f.input.question, [name.fact_id]),
  ).toThrow('不适合发送');
  expect(
    eligibleAnswerFacts(f.profile).every((x) => !x.path.startsWith('basic.')),
  ).toBe(true);
});
it('完整事实引用保留否定词、实体与值；拒绝改写、未知 ID、评分与额外字段', async () => {
  const f = await fixture(),
    selection = answerSelection(f.input);
  expect(f.result.generated_text).toContain('未负责数据库优化');
  expect(f.result.input_hash).toBe(await hashJson(f.input));
  const changed = structuredClone(selection);
  changed.citations[1]!.quote = '使用Java实现接口，负责数据库优化。';
  for (const bad of [
    changed,
    { ...selection, score: 100 },
    {
      ...selection,
      citations: [{ ...selection.citations[0]!, fact_id: 'fake' }],
    },
    {
      ...selection,
      citations: [{ ...selection.citations[0]!, requirement_ids: ['fake'] }],
    },
    {
      ...selection,
      citations: [selection.citations[0], selection.citations[0]],
    },
    { ...selection, citations: [] },
  ]) {
    await expect(validateAnswerModel(f.input, bad, meta)).rejects.toThrow();
  }
});
it('原始草稿不能审核/导出；本人修改、保存和审核必须分开', async () => {
  const f = await fixture();
  expect(() => exportAnswer(f.draft, f.job, f.profile)).toThrow('先修改');
  expect(() =>
    reviseAnswer(f.draft, { approve: true }, f.job, f.profile),
  ).toThrow('先结合真实情况修改');
  expect(() =>
    reviseAnswer(f.draft, { text: 'x', approve: true }, f.job, f.profile),
  ).toThrow('分开');
  const edited = reviseAnswer(
    f.draft,
    { text: f.draft.text + '\n这是我核对后的回答。' },
    f.job,
    f.profile,
  );
  expect(edited.status).toBe('draft');
  expect(edited.user_edited).toBe(true);
  const approved = reviseAnswer(edited, { approve: true }, f.job, f.profile);
  expect(exportAnswer(approved, f.job, f.profile)).toContain('核对后的回答');
  const again = reviseAnswer(
    approved,
    { text: approved.text + '\n进一步修改。' },
    f.job,
    f.profile,
  );
  expect(again.status).toBe('draft');
  expect(again.approved_at).toBeNull();
});
it('仅空白修改不算本人编辑；历史恢复生成新修订而不恢复审核', async () => {
  const f = await fixture();
  const whitespace = reviseAnswer(
    f.draft,
    { text: f.draft.text + '\n ' },
    f.job,
    f.profile,
  );
  expect(whitespace.user_edited).toBe(false);
  const edited = reviseAnswer(
    whitespace,
    { text: whitespace.text + '\n本人确认的说明。' },
    f.job,
    f.profile,
  );
  const approved = reviseAnswer(edited, { approve: true }, f.job, f.profile);
  const restored = reviseAnswer(
    approved,
    { restore_revision: edited.revision },
    f.job,
    f.profile,
  );
  expect(restored.status).toBe('draft');
  expect(restored.revision).toBe(approved.revision + 1);
  expect(restored.text).toBe(edited.text);
});
it('资料、JD、日期、规则变化阻止旧答案使用，来源快照仍可审计', async () => {
  const f = await fixture(),
    edited = reviseAnswer(
      f.draft,
      { text: f.draft.text + '\n本人核对。' },
      f.job,
      f.profile,
    ),
    approved = reviseAnswer(edited, { approve: true }, f.job, f.profile);
  const changed = reviseFact(f.profile, f.input.facts[0]!.fact_id, {
    confirmation: 'rejected',
  });
  expect(() => exportAnswer(approved, f.job, changed)).toThrow('资料已变化');
  expect(() =>
    exportAnswer(approved, reviseJob(f.job, { confirm_all: true }), f.profile),
  ).toThrow('资料已变化');
  expect(isAnswerCurrent(approved, f.job, f.profile, '2099-01-01')).toBe(false);
  expect(
    isAnswerCurrent({ ...approved, engine_version: 'old' }, f.job, f.profile),
  ).toBe(false);
  validateAnswerSnapshots(f.input, f.facts, changed);
});
it('接受结果绑定输入摘要和本地快照，篡改材料或生成正文不能保存', async () => {
  const f = await fixture();
  await expect(
    acceptAnswer(
      { ...f.input, question: '另一题' },
      f.facts,
      f.result,
      await answerConsent(f.input),
    ),
  ).rejects.toThrow('不一致');
  const forged = structuredClone(f.draft);
  forged.facts[0]!.value = '虚构材料';
  expect(() => validateAnswerDraft(forged)).toThrow('不一致');
  const fakeText = structuredClone(f.draft);
  fakeText.result.generated_text = '虚构成绩';
  expect(() => validateAnswerDraft(fakeText)).toThrow('偏离');
  expect(() =>
    renderAnswer(f.input, {
      ...f.result.selection,
      citations: f.result.selection.citations.map((c) => ({
        ...c,
        quote: c.quote.slice(1),
      })),
    }),
  ).toThrow('EVIDENCE_INVALID');
});
it('并发修订与来源替换被拒绝，历史与答案数量有界', async () => {
  const f = await fixture();
  let state = putAnswer(putCareerJob(emptyCareer(), f.job), f.draft);
  const edited = reviseAnswer(
    f.draft,
    { text: f.draft.text + '\n本人说明。' },
    f.job,
    f.profile,
  );
  state = putAnswer(state, edited, f.draft.revision);
  expect(() => putAnswer(state, edited, f.draft.revision)).toThrow(
    '修订已变化',
  );
  const forged = structuredClone(edited);
  forged.revision++;
  forged.input.question = '其他问题';
  expect(() => putAnswer(state, forged, edited.revision)).toThrow('来源快照');
  let a = edited;
  for (let i = 0; i < 12; i++)
    a = reviseAnswer(a, { text: a.text + '。' }, f.job, f.profile);
  expect(a.history).toHaveLength(10);
  state.answers = Array.from({ length: 30 }, () => ({
    ...f.draft,
    answer_id: crypto.randomUUID(),
  }));
  expect(() =>
    putAnswer(state, { ...f.draft, answer_id: crypto.randomUUID() }),
  ).toThrow('30');
});
