import { Type, type Static, type TProperties } from '@sinclair/typebox';
import { Id, CategorySchema, PathSchema, FactValueSchema } from './profile';
const object = <T extends TProperties>(p: T) =>
  Type.Object(p, { additionalProperties: false });
const timestamp = Type.Integer({ minimum: 0 });
const revision = Type.Integer({ minimum: 1 });
const status = Type.Union([Type.Literal('draft'), Type.Literal('approved')]);
export const ResumeFactSchema = object({
  fact_id: Id,
  fact_revision: revision,
  entity_id: Id,
  category: CategorySchema,
  path: PathSchema,
  value: FactValueSchema,
  source_type: Type.Union([Type.Literal('resume'), Type.Literal('user')]),
  evidences: Type.Array(
    object({
      evidence_id: Id,
      document_id: Id,
      block_id: Id,
      page: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
      quote: Type.String({ minLength: 1, maxLength: 1600 }),
      start: Type.Integer({ minimum: 0 }),
      end: Type.Integer({ minimum: 1 }),
    }),
    { maxItems: 20 },
  ),
  relevance: Type.Array(
    object({
      requirement_id: Id,
      kind: Type.Union([Type.Literal('matched'), Type.Literal('related')]),
    }),
    { maxItems: 60 },
  ),
});
export type ResumeFact = Static<typeof ResumeFactSchema>;
export const ResumeBlockSchema = object({
  block_id: Id,
  entity_id: Id,
  category: CategorySchema,
  facts: Type.Array(ResumeFactSchema, { minItems: 1, maxItems: 60 }),
});
export type ResumeBlock = Static<typeof ResumeBlockSchema>;
const editor = {
  name: Type.String({ minLength: 1, maxLength: 160 }),
  block_order: Type.Array(Id, { minItems: 1, maxItems: 80 }),
  selected_fact_ids: Type.Array(Id, { minItems: 1, maxItems: 400 }),
  status,
  approved_at: Type.Union([timestamp, Type.Null()]),
};
export const ResumeVariantSchema = object({
  schema_version: Type.Literal(1),
  resume_id: Id,
  based_on_resume_id: Type.Union([Id, Type.Null()]),
  job_id: Id,
  job_revision: revision,
  job_source_hash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  job_title: Type.String({ maxLength: 200 }),
  company: Type.String({ maxLength: 200 }),
  requirements: Type.Array(
    object({
      requirement_id: Id,
      quote: Type.String({ minLength: 1, maxLength: 1200 }),
    }),
    { minItems: 1, maxItems: 60 },
  ),
  profile_revision: Type.Integer({ minimum: 0 }),
  engine_version: Type.String({ minLength: 1, maxLength: 80 }),
  as_of: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  created_at: timestamp,
  updated_at: timestamp,
  revision,
  blocks: Type.Array(ResumeBlockSchema, { minItems: 1, maxItems: 80 }),
  ...editor,
  change_note: Type.String({ minLength: 1, maxLength: 500 }),
  history: Type.Array(
    object({
      revision,
      updated_at: timestamp,
      ...editor,
      change_note: Type.String({ minLength: 1, maxLength: 500 }),
    }),
    { maxItems: 10 },
  ),
});
export type ResumeVariant = Static<typeof ResumeVariantSchema>;
