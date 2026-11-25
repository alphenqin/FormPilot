import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
const obj = <T extends import('@sinclair/typebox').TProperties>(p: T) =>
  Type.Object(p, { additionalProperties: false });
export const Id = Type.String({ pattern: '^[a-zA-Z0-9-]{1,80}$' });
export const CategorySchema = Type.Union(
  [
    'basic',
    'education',
    'work',
    'internship',
    'project',
    'skill',
    'certificate',
    'intention',
  ].map((x) => Type.Literal(x)),
);
export type Category = Static<typeof CategorySchema>;
export const PATHS = [
  'basic.name',
  'basic.gender',
  'basic.phone',
  'basic.email',
  'basic.current_city',
  'education.school',
  'education.major',
  'education.degree',
  'education.start_date',
  'education.end_date',
  'work.company',
  'work.position',
  'work.department',
  'work.start_date',
  'work.end_date',
  'work.description',
  'internship.company',
  'internship.position',
  'internship.start_date',
  'internship.end_date',
  'internship.description',
  'project.name',
  'project.role',
  'project.start_date',
  'project.end_date',
  'project.description',
  'skill.name',
  'skill.level',
  'certificate.name',
  'certificate.date',
  'certificate.number',
  'intention.city',
  'intention.industry',
  'intention.position',
  'intention.salary',
] as const;
export const PathSchema = Type.Union(PATHS.map((x) => Type.Literal(x)));
export type FactPath = Static<typeof PathSchema>;
export const DateSchema = obj({
  value: Type.String({ maxLength: 10 }),
  precision: Type.Union(
    ['year', 'month', 'day', 'present'].map((x) => Type.Literal(x)),
  ),
});
export const FactValueSchema = Type.Union([
  Type.String({ minLength: 1, maxLength: 3000 }),
  DateSchema,
]);
export type FactValue = Static<typeof FactValueSchema>;
export const BlockSchema = obj({
  block_id: Id,
  document_id: Id,
  document_revision: Type.Literal(1),
  page: Type.Union([Type.Integer({ minimum: 1, maximum: 100 }), Type.Null()]),
  text: Type.String({ minLength: 1, maxLength: 1600 }),
  start: Type.Integer({ minimum: 0 }),
  end: Type.Integer({ minimum: 1 }),
});
export type SourceBlock = Static<typeof BlockSchema>;
// M1 草案：与 M3 冻结的完整四接口 schema 区分。
export const CandidateSchema = obj({
  category: CategorySchema,
  path: PathSchema,
  value: FactValueSchema,
  entity_key: Type.String({ minLength: 1, maxLength: 80 }),
  block_id: Id,
  quote: Type.String({ minLength: 1, maxLength: 1600 }),
});
export const ExtractionSchema = obj({
  candidates: Type.Array(CandidateSchema, { maxItems: 200 }),
});
export type Extraction = Static<typeof ExtractionSchema>;
export type Candidate = Static<typeof CandidateSchema>;
export const ConsentSchema = obj({
  granted: Type.Literal(true),
  purpose: Type.Literal('resume_parse'),
  provider: Type.String({ maxLength: 80 }),
  model: Type.String({ maxLength: 100 }),
  policy_url: Type.String({ maxLength: 500 }),
  blocks_hash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  granted_at: Type.Integer({ minimum: 0 }),
});
export const ParseRequestSchema = obj({
  client_request_id: Id,
  document_id: Id,
  document_revision: Type.Literal(1),
  source_blocks: Type.Array(BlockSchema, { minItems: 1, maxItems: 200 }),
  consent: ConsentSchema,
});
export type ParseRequest = Static<typeof ParseRequestSchema>;
export const UsageSchema = obj({
  input_tokens: Type.Integer({ minimum: 0 }),
  output_tokens: Type.Integer({ minimum: 0 }),
});
export const ParseResultSchema = obj({
  extraction: ExtractionSchema,
  usage: UsageSchema,
  provider: Type.String(),
  model: Type.String(),
  duration_ms: Type.Number({ minimum: 0 }),
});
export type ParseResult = Static<typeof ParseResultSchema>;
export const JobSchema = obj({
  job_id: Id,
  status: Type.Union(
    ['running', 'succeeded', 'failed'].map((x) => Type.Literal(x)),
  ),
  result: Type.Union([ParseResultSchema, Type.Null()]),
  error_code: Type.Union([Type.String({ maxLength: 80 }), Type.Null()]),
  expires_at: Type.Integer(),
});
export type ParseJob = Static<typeof JobSchema>;
export const SessionRequestSchema = obj({ workspace_id: Id });
export const SessionSchema = obj({
  session_token: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  expires_at: Type.Integer(),
});
export function validateExtraction(value: unknown): Extraction {
  if (!Value.Check(ExtractionSchema, value))
    throw new Error('MODEL_INVALID_OUTPUT');
  return value;
}
