import { AnswerDraftSchema, AnswerPendingSchema } from './answer';
import { Type, type Static } from '@sinclair/typebox';
import { ResumeVariantSchema } from './resume';
import { Id, UsageSchema } from './profile';
const object = <T extends import('@sinclair/typebox').TProperties>(p: T) =>
  Type.Object(p, { additionalProperties: false });
const nullable = <T extends import('@sinclair/typebox').TSchema>(s: T) =>
  Type.Union([s, Type.Null()]);
const short = (n = 200) => Type.String({ maxLength: n });
const digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const JobKindSchema = Type.Union(
  (
    [
      'education',
      'experience',
      'skill',
      'location',
      'major',
      'responsibility',
      'other',
    ] as const
  ).map((v) => Type.Literal(v)),
);
export type JobKind = Static<typeof JobKindSchema>;
export const JobPrioritySchema = Type.Union(
  (['hard', 'core', 'preferred'] as const).map((v) => Type.Literal(v)),
);
export type JobPriority = Static<typeof JobPrioritySchema>;
const span = {
  quote: Type.String({ minLength: 1, maxLength: 1200 }),
  start: Type.Integer({ minimum: 0 }),
  end: Type.Integer({ minimum: 1 }),
};
export const JobSourceSchema = object({
  source_id: Id,
  text: Type.String({ minLength: 1, maxLength: 20000 }),
  title_hint: short(),
  page_url: nullable(short(500)),
  captured_at: Type.Integer({ minimum: 0 }),
  method: Type.Union([Type.Literal('paste'), Type.Literal('page')]),
  truncated: Type.Optional(Type.Boolean()),
});
export type JobSource = Static<typeof JobSourceSchema>;
export const JobModelOutputSchema = object({
  attributes: Type.Array(
    object({
      key: Type.Union(
        (['title', 'company', 'location'] as const).map((v) => Type.Literal(v)),
      ),
      value: Type.String({ minLength: 1, maxLength: 200 }),
      quote: span.quote,
    }),
    { maxItems: 12 },
  ),
  requirements: Type.Array(
    object({
      kind: JobKindSchema,
      priority: JobPrioritySchema,
      quote: span.quote,
      term: nullable(short(100)),
    }),
    { maxItems: 40 },
  ),
});
export type JobModelOutput = Static<typeof JobModelOutputSchema>;
export const JobCriterionSchema = object({
  type: Type.Union(
    (
      [
        'degree_min',
        'degree_exact',
        'years_min',
        'skill',
        'location_intention',
        'location_current',
        'major_exact',
        'unknown',
      ] as const
    ).map((v) => Type.Literal(v)),
  ),
  value: nullable(short(200)),
  min_years: nullable(Type.Number({ minimum: 0, maximum: 50 })),
  level: nullable(
    Type.Union(
      (['familiar', 'proficient', 'expert'] as const).map((v) =>
        Type.Literal(v),
      ),
    ),
  ),
  reason: nullable(short(100)),
});
export type JobCriterion = Static<typeof JobCriterionSchema>;
export const JobAttributeSchema = object({
  ...span,
  attribute_id: Id,
  key: Type.Union(
    (['title', 'company', 'location'] as const).map((v) => Type.Literal(v)),
  ),
  value: Type.String({ minLength: 1, maxLength: 200 }),
  confirmed: Type.Boolean(),
});
export const JobRequirementSchema = object({
  ...span,
  requirement_id: Id,
  kind: JobKindSchema,
  priority: JobPrioritySchema,
  term: nullable(short(100)),
  criterion: JobCriterionSchema,
  confirmed: Type.Boolean(),
});
export type JobRequirement = Static<typeof JobRequirementSchema>;
const jobVersion = {
  revision: Type.Integer({ minimum: 1 }),
  attributes: Type.Array(JobAttributeSchema, { maxItems: 12 }),
  requirements: Type.Array(JobRequirementSchema, { maxItems: 60 }),
  reviewed: Type.Boolean(),
  updated_at: Type.Integer({ minimum: 0 }),
};
export const ParsedJobSchema = object({
  schema_version: Type.Literal(1),
  source_hash: digest,
  attributes: Type.Array(JobAttributeSchema, { maxItems: 12 }),
  requirements: Type.Array(JobRequirementSchema, { maxItems: 40 }),
  provider: short(80),
  model: short(100),
  usage: UsageSchema,
  duration_ms: Type.Number({ minimum: 0 }),
});
export type ParsedJob = Static<typeof ParsedJobSchema>;
export const JobDocumentSchema = object({
  schema_version: Type.Literal(1),
  job_id: Id,
  source: JobSourceSchema,
  source_hash: digest,
  ...jobVersion,
  created_at: Type.Integer({ minimum: 0 }),
  provider: short(80),
  model: short(100),
  usage: UsageSchema,
  duration_ms: Type.Number({ minimum: 0 }),
  history: Type.Array(object(jobVersion), { maxItems: 10 }),
});
export type JobDocument = Static<typeof JobDocumentSchema>;
export const JobParseRequestSchema = object({
  schema_version: Type.Literal(1),
  client_request_id: Id,
  source: JobSourceSchema,
  consent: object({
    granted: Type.Literal(true),
    purpose: Type.Literal('jd_parse'),
    provider: Type.String({ minLength: 1, maxLength: 80 }),
    model: Type.String({ minLength: 1, maxLength: 100 }),
    policy_url: short(500),
    payload_hash: digest,
    granted_at: Type.Integer({ minimum: 0 }),
  }),
});
export type JobParseRequest = Static<typeof JobParseRequestSchema>;
export const JobParseTaskSchema = object({
  job_id: Type.String({ pattern: '^[a-f0-9]{32}$' }),
  status: Type.Union(
    (['running', 'succeeded', 'failed'] as const).map((v) => Type.Literal(v)),
  ),
  result: nullable(ParsedJobSchema),
  error_code: nullable(short(80)),
  expires_at: Type.Integer({ minimum: 0 }),
});
export type JobParseTask = Static<typeof JobParseTaskSchema>;
export const JobMatchStatusSchema = Type.Union(
  (['matched', 'insufficient', 'needs_confirmation', 'unmatched'] as const).map(
    (v) => Type.Literal(v),
  ),
);
export const JobMatchRowSchema = object({
  requirement_id: Id,
  status: JobMatchStatusSchema,
  reason_code: short(100),
  explanation: short(700),
  fact_refs: Type.Array(
    object({
      fact_id: Id,
      fact_revision: Type.Integer({ minimum: 1 }),
      entity_id: Id,
    }),
    { maxItems: 100 },
  ),
  evidence_ids: Type.Array(Id, { maxItems: 200 }),
});
export type JobMatchRow = Static<typeof JobMatchRowSchema>;
export const JobMatchSchema = object({
  schema_version: Type.Literal(1),
  analysis_id: Id,
  job_id: Id,
  job_revision: Type.Integer({ minimum: 1 }),
  job_digest: digest,
  profile_revision: Type.Integer({ minimum: 0 }),
  engine_version: short(80),
  as_of: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  created_at: Type.Integer({ minimum: 0 }),
  rows: Type.Array(JobMatchRowSchema, { maxItems: 60 }),
  summary: object({
    matched: Type.Integer({ minimum: 0 }),
    insufficient: Type.Integer({ minimum: 0 }),
    needs_confirmation: Type.Integer({ minimum: 0 }),
    unmatched: Type.Integer({ minimum: 0 }),
  }),
  final_hiring_decision: Type.Literal(false),
});
export type JobMatch = Static<typeof JobMatchSchema>;
export const CareerStateSchema = object({
  schema_version: Type.Literal(1),
  revision: Type.Integer({ minimum: 0 }),
  jobs: Type.Array(JobDocumentSchema, { maxItems: 20 }),
  analyses: Type.Array(JobMatchSchema, { maxItems: 60 }),
  resumes: Type.Optional(Type.Array(ResumeVariantSchema, { maxItems: 20 })),
  answers: Type.Optional(Type.Array(AnswerDraftSchema, { maxItems: 30 })),
  answer_pending: Type.Optional(
    Type.Array(AnswerPendingSchema, { maxItems: 3 }),
  ),
  pending: Type.Optional(
    Type.Array(
      object({
        request: JobParseRequestSchema,
        api_job_id: nullable(Type.String({ pattern: '^[a-f0-9]{32}$' })),
        started_at: Type.Integer({ minimum: 0 }),
      }),
      { maxItems: 3 },
    ),
  ),
});
export type CareerState = Static<typeof CareerStateSchema>;
const msg = {
  protocol_version: Type.Literal('1'),
  request_id: Id,
  task_id: Type.Null(),
  method: Type.Literal('career.capture'),
  tab_id: Type.Integer({ minimum: 0 }),
};
export const JobCaptureMessageSchema = object(msg);
export const JobCaptureResultSchema = object({
  source: JobSourceSchema,
  warning_codes: Type.Array(short(80), { maxItems: 10 }),
});
