import {
  eligibleAnswerFacts,
  makeAnswerInput,
  displayValue,
} from '@formpilot/domain';
import {
  hashJson,
  type AnswerInput,
  type AnswerModelOutput,
  type AnswerRequest,
} from '@formpilot/contracts';
import { qualifiedProfile, profileFact, reviewedJob } from './career';
export async function answerFixture() {
  const job = await reviewedJob([
    { kind: 'skill', quote: '熟练掌握Java。', term: 'Java' },
  ]);
  let p = profileFact(qualifiedProfile(), 'project.name', '合成服务项目');
  p = profileFact(
    p.profile,
    'project.description',
    '使用Java实现接口，未负责数据库优化。',
    p.entity_id,
  );
  p = profileFact(p.profile, 'basic.name', 'PRIVATE_NAME_NOT_SENT');
  p = profileFact(
    p.profile,
    'work.description',
    'PENDING_NOT_SENT',
    null,
    false,
  );
  const facts = eligibleAnswerFacts(p.profile).filter((f) =>
    f.path.startsWith('project.'),
  );
  const source = makeAnswerInput(
    job,
    p.profile,
    '描述一次项目经历',
    facts.map((f) => f.fact_id),
  );
  return { job, profile: p.profile, ...source };
}
export function answerSelection(input: AnswerInput): AnswerModelOutput {
  return {
    focus: 'experience',
    citations: input.facts.slice(0, 6).map((f) => ({
      fact_id: f.fact_id,
      quote: displayValue(f.value),
      requirement_ids: [input.job.requirements[0]!.requirement_id],
    })),
  };
}

export async function answerConsent(
  input: AnswerInput,
  provider = 'controlled',
  model = 'test',
): Promise<AnswerRequest['consent']> {
  return {
    granted: true,
    purpose: 'answer_generate',
    provider,
    model,
    policy_url: 'https://example.test/policy',
    payload_hash: await hashJson(input),
    granted_at: Date.now(),
  };
}
