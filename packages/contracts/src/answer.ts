import { Type, type Static, type TProperties } from '@sinclair/typebox';
import { Id, PathSchema, FactValueSchema, UsageSchema } from './profile';
import { ResumeFactSchema } from './resume';
const obj = <T extends TProperties>(p: T) =>
  Type.Object(p, { additionalProperties: false });
const rev = Type.Integer({ minimum: 1 });
const time = Type.Integer({ minimum: 0 });
export const OpenAnswerInputSchema = obj({
  question: Type.String({ minLength: 1, maxLength: 1500 }),
  profile_revision: Type.Integer({ minimum: 0 }),
  job: obj({
    job_id: Id,
    revision: rev,
    source_hash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    title: Type.String({ maxLength: 200 }),
    company: Type.String({ maxLength: 200 }),
    requirements: Type.Array(
      obj({
        requirement_id: Id,
        quote: Type.String({ minLength: 1, maxLength: 1200 }),
      }),
      { minItems: 1, maxItems: 60 },
    ),
  }),
  facts: Type.Array(
    obj({
      fact_id: Id,
      fact_revision: rev,
      entity_id: Id,
      path: PathSchema,
      value: FactValueSchema,
    }),
    { minItems: 1, maxItems: 16 },
  ),
});
export type AnswerInput = Static<typeof OpenAnswerInputSchema>;
export const AnswerModelOutputSchema = obj({
  focus: Type.Union(
    (
      ['strength', 'motivation', 'challenge', 'experience', 'general'] as const
    ).map((v) => Type.Literal(v)),
  ),
  citations: Type.Array(
    obj({
      fact_id: Id,
      quote: Type.String({ minLength: 1, maxLength: 3000 }),
      requirement_ids: Type.Array(Id, { maxItems: 6 }),
    }),
    { maxItems: 6 },
  ),
});
export type AnswerModelOutput = Static<typeof AnswerModelOutputSchema>;
export const AnswerResultSchema = obj({
  input_hash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  selection: AnswerModelOutputSchema,
  generated_text: Type.String({ minLength: 1, maxLength: 6000 }),
  provider: Type.String({ maxLength: 80 }),
  model: Type.String({ maxLength: 100 }),
  usage: UsageSchema,
  duration_ms: Type.Number({ minimum: 0 }),
});
export type AnswerResult = Static<typeof AnswerResultSchema>;
export const AnswerConsentSchema = obj({
  granted: Type.Literal(true),
  purpose: Type.Literal('answer_generate'),
  provider: Type.String({ minLength: 1, maxLength: 80 }),
  model: Type.String({ minLength: 1, maxLength: 100 }),
  policy_url: Type.String({ maxLength: 500 }),
  payload_hash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  granted_at: time,
});
export const AnswerRequestSchema = obj({
  schema_version: Type.Literal(1),
  client_request_id: Id,
  input: OpenAnswerInputSchema,
  consent: AnswerConsentSchema,
});
export type AnswerRequest = Static<typeof AnswerRequestSchema>;
export const AnswerTaskSchema = obj({
  job_id: Type.String({ pattern: '^[a-f0-9]{32}$' }),
  status: Type.Union(
    (['running', 'succeeded', 'failed'] as const).map((v) => Type.Literal(v)),
  ),
  result: Type.Union([AnswerResultSchema, Type.Null()]),
  error_code: Type.Union([Type.String({ maxLength: 80 }), Type.Null()]),
  expires_at: time,
});
export type AnswerTask = Static<typeof AnswerTaskSchema>;
const editor = {
  text: Type.String({ minLength: 1, maxLength: 6000 }),
  user_edited: Type.Boolean(),
  status: Type.Union([Type.Literal('draft'), Type.Literal('approved')]),
  approved_at: Type.Union([time, Type.Null()]),
};
export const AnswerDraftSchema = obj({
  schema_version: Type.Literal(1),
  answer_id: Id,
  input: OpenAnswerInputSchema,
  result: AnswerResultSchema,
  consent: AnswerConsentSchema,
  facts: Type.Array(ResumeFactSchema, { minItems: 1, maxItems: 16 }),
  engine_version: Type.String({ maxLength: 80 }),
  as_of: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  revision: rev,
  created_at: time,
  updated_at: time,
  ...editor,
  history: Type.Array(obj({ revision: rev, updated_at: time, ...editor }), {
    maxItems: 10,
  }),
});
export type AnswerDraft = Static<typeof AnswerDraftSchema>;
export const AnswerPendingSchema = obj({
  request: AnswerRequestSchema,
  facts: Type.Array(ResumeFactSchema, { minItems: 1, maxItems: 16 }),
  api_job_id: Type.Union([
    Type.String({ pattern: '^[a-f0-9]{32}$' }),
    Type.Null(),
  ]),
  started_at: time,
});
export type AnswerPending = Static<typeof AnswerPendingSchema>;
