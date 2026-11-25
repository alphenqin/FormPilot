import { Type, type Static } from '@sinclair/typebox';
import {
  Id,
  CategorySchema,
  PathSchema,
  FactValueSchema,
  UsageSchema,
} from './profile';
import { FormSnapshotSchema, ScanRefSchema, ScannedFieldSchema } from './scan';
const obj = <T extends import('@sinclair/typebox').TProperties>(
  properties: T,
) => Type.Object(properties, { additionalProperties: false });
const nullable = <T extends import('@sinclair/typebox').TSchema>(schema: T) =>
  Type.Union([schema, Type.Null()]);
const text = (max = 200) => Type.String({ maxLength: max });
const digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const FieldValueSchema = ScannedFieldSchema.properties.current_value;
export type FieldValue = Static<typeof FieldValueSchema>;
export const PrecisionSchema = Type.Union([
  Type.Literal('year'),
  Type.Literal('month'),
  Type.Literal('day'),
  Type.Literal('present'),
]);
export const TaskStateSchema = Type.Union([
  Type.Literal('DRAFT'),
  Type.Literal('PLANNED'),
  Type.Literal('WAITING_USER'),
  Type.Literal('READY'),
  Type.Literal('WRITING'),
  Type.Literal('REVIEW'),
]);
export type TaskState = Static<typeof TaskStateSchema>;
export const PlanFactSchema = obj({
  fact_id: Id,
  fact_revision: Type.Integer({ minimum: 1 }),
  profile_revision: Type.Integer({ minimum: 0 }),
  category: CategorySchema,
  path: PathSchema,
  value: FactValueSchema,
  entity_id: Id,
  confirmation: Type.Literal('confirmed'),
  source_type: Type.Union([Type.Literal('resume'), Type.Literal('user')]),
  evidence_ids: Type.Array(Id, { maxItems: 20 }),
  document_id: nullable(Id),
});
export type PlanFact = Static<typeof PlanFactSchema>;
export const PlanEvidenceSchema = obj({
  evidence_id: Id,
  document_id: Id,
  document_revision: Type.Literal(1),
  block_id: Id,
  page: nullable(Type.Integer({ minimum: 1, maximum: 100 })),
  quote: Type.String({ minLength: 1, maxLength: 1600 }),
  start: Type.Integer({ minimum: 0 }),
  end: Type.Integer({ minimum: 1 }),
});
export const PlanEntitySchema = obj({
  entity_id: Id,
  category: CategorySchema,
  label: text(),
});
export const EntityBindingSchema = obj({
  group_id: Id,
  category: CategorySchema,
  entity_id: Id,
  source: Type.Union([Type.Literal('rule'), Type.Literal('user')]),
});
export type EntityBinding = Static<typeof EntityBindingSchema>;
export const TaskAnswerSchema = obj({
  answer_id: Id,
  question_id: Id,
  semantic_key: Type.String({ minLength: 1, maxLength: 1000 }),
  field_ids: Type.Array(Id, { minItems: 1, maxItems: 250 }),
  value: FieldValueSchema,
  precision: nullable(PrecisionSchema),
  scope: Type.Literal('task'),
  source: Type.Literal('user'),
  revision: Type.Integer({ minimum: 1 }),
});
export type TaskAnswer = Static<typeof TaskAnswerSchema>;
export const PlanQuestionSchema = obj({
  question_id: Id,
  semantic_key: Type.String({ minLength: 1, maxLength: 1000 }),
  field_ids: Type.Array(Id, { minItems: 1, maxItems: 250 }),
  kind: Type.Union([
    Type.Literal('value'),
    Type.Literal('entity'),
    Type.Literal('mapping'),
  ]),
  semantic_path: nullable(PathSchema),
  group_id: Id,
  category: nullable(CategorySchema),
  prompt: Type.String({ minLength: 1, maxLength: 300 }),
  answer_type: Type.Union([
    Type.Literal('text'),
    Type.Literal('single'),
    Type.Literal('multiple'),
    Type.Literal('date'),
    Type.Literal('month'),
    Type.Literal('number'),
    Type.Literal('boolean'),
  ]),
  options: Type.Array(obj({ value: text(4096), label: text() }), {
    maxItems: 200,
  }),
  required: Type.Boolean(),
  current_answer: FieldValueSchema,
  source: Type.Literal('user'),
  scope: Type.Literal('task'),
});
export type PlanQuestion = Static<typeof PlanQuestionSchema>;
export const FieldDecisionSchema = obj({
  field_id: Id,
  field_label: text(),
  group_id: Id,
  entity_group_id: Id,
  semantic_path: nullable(PathSchema),
  decision: Type.Union([
    Type.Literal('fill'),
    Type.Literal('ask'),
    Type.Literal('review'),
    Type.Literal('manual'),
    Type.Literal('skip'),
  ]),
  current_value: FieldValueSchema,
  target_value: FieldValueSchema,
  candidate_value: FieldValueSchema,
  fact_refs: Type.Array(
    obj({ fact_id: Id, fact_revision: Type.Integer({ minimum: 1 }) }),
    { maxItems: 20 },
  ),
  answer_refs: Type.Array(Id, { maxItems: 20 }),
  evidence_ids: Type.Array(Id, { maxItems: 100 }),
  entity_id: nullable(Id),
  reason_code: text(80),
  value_precision: nullable(PrecisionSchema),
  replacement_confirmed: Type.Boolean(),
});
export type FieldDecision = Static<typeof FieldDecisionSchema>;
export const PlanConsentSchema = obj({
  granted: Type.Literal(true),
  purpose: Type.Literal('fill_plan'),
  provider: Type.String({ minLength: 1, maxLength: 80 }),
  model: Type.String({ minLength: 1, maxLength: 100 }),
  policy_url: text(500),
  payload_hash: digest,
  granted_at: Type.Integer({ minimum: 0 }),
});
export const FillPlanRequestSchema = obj({
  schema_version: Type.Literal(1),
  client_request_id: Id,
  task_id: Id,
  expected_plan_revision: Type.Integer({ minimum: 0 }),
  profile_revision: Type.Integer({ minimum: 0 }),
  form_snapshot: FormSnapshotSchema,
  confirmed_facts: Type.Array(PlanFactSchema, { maxItems: 250 }),
  entities: Type.Array(PlanEntitySchema, { maxItems: 100 }),
  evidences: Type.Array(PlanEvidenceSchema, { maxItems: 500 }),
  task_answers: Type.Array(TaskAnswerSchema, { maxItems: 250 }),
  consent: PlanConsentSchema,
});
export type FillPlanRequest = Static<typeof FillPlanRequestSchema>;
export const ModelMappingSchema = obj({
  mappings: Type.Array(
    obj({ field_id: Id, path: nullable(PathSchema), entity_id: nullable(Id) }),
    { maxItems: 250 },
  ),
});
export type ModelMappings = Static<typeof ModelMappingSchema>;
export const FillPlanSchema = obj({
  schema_version: Type.Literal(1),
  plan_id: Id,
  plan_revision: Type.Integer({ minimum: 1 }),
  task_id: Id,
  profile_revision: Type.Integer({ minimum: 0 }),
  snapshot_ref: ScanRefSchema,
  form_snapshot_id: Id,
  dom_fingerprint: digest,
  field_decisions: Type.Array(FieldDecisionSchema, { maxItems: 250 }),
  questions: Type.Array(PlanQuestionSchema, { maxItems: 500 }),
  task_answers: Type.Array(TaskAnswerSchema, { maxItems: 500 }),
  entity_bindings: Type.Array(EntityBindingSchema, { maxItems: 500 }),
  degraded: Type.Boolean(),
  degraded_reason: nullable(text(80)),
  plan_digest: digest,
  created_at: Type.Integer(),
  expires_at: Type.Integer(),
  duration_ms: Type.Number({ minimum: 0 }),
  usage: UsageSchema,
  application_submitted: Type.Literal(false),
});
export type FillPlan = Static<typeof FillPlanSchema>;
export const ApprovalSchema = obj({
  approval_id: Id,
  plan_id: Id,
  plan_revision: Type.Integer({ minimum: 1 }),
  plan_digest: digest,
  task_id: Id,
  profile_revision: Type.Integer({ minimum: 0 }),
  snapshot_ref: ScanRefSchema,
  approved_field_ids: Type.Array(Id, { minItems: 1, maxItems: 250 }),
  approved_at: Type.Integer(),
});
export type Approval = Static<typeof ApprovalSchema>;
export const FillPlanViewSchema = obj({
  ...FillPlanSchema.properties,
  status: TaskStateSchema,
  state_revision: Type.Integer({ minimum: 1 }),
  user_approval: nullable(ApprovalSchema),
  invalid_reason: nullable(text(80)),
});
export type FillPlanView = Static<typeof FillPlanViewSchema>;
export const AnswerInputSchema = obj({
  question_id: Id,
  value: FieldValueSchema,
  precision: nullable(PrecisionSchema),
  scope: Type.Literal('task'),
});
export const FieldResolutionSchema = Type.Union([
  obj({
    type: Type.Union([
      Type.Literal('keep'),
      Type.Literal('replace'),
      Type.Literal('cancel'),
      Type.Literal('manual'),
    ]),
    field_id: Id,
  }),
  obj({
    type: Type.Literal('edit'),
    field_id: Id,
    value: FieldValueSchema,
    precision: nullable(PrecisionSchema),
  }),
  obj({ type: Type.Literal('map_field'), field_id: Id, path: PathSchema }),
  obj({
    type: Type.Literal('bind_entity'),
    group_id: Id,
    category: CategorySchema,
    entity_id: Id,
  }),
]);
export type FieldResolution = Static<typeof FieldResolutionSchema>;
export const ResolveRequestSchema = obj({
  schema_version: Type.Literal(1),
  client_request_id: Id,
  task_id: Id,
  plan_id: Id,
  expected_plan_revision: Type.Integer({ minimum: 1 }),
  answers: Type.Array(AnswerInputSchema, { maxItems: 250 }),
  resolutions: Type.Array(FieldResolutionSchema, { maxItems: 250 }),
});
export type ResolveRequest = Static<typeof ResolveRequestSchema>;
export const ApproveRequestSchema = obj({
  schema_version: Type.Literal(1),
  client_request_id: Id,
  task_id: Id,
  plan_id: Id,
  expected_plan_revision: Type.Integer({ minimum: 1 }),
  plan_digest: digest,
  approved_field_ids: Type.Array(Id, { minItems: 1, maxItems: 250 }),
  observed_profile_revision: Type.Integer({ minimum: 0 }),
  observed_snapshot_ref: ScanRefSchema,
  observed_at: Type.Integer(),
});
export type ApproveRequest = Static<typeof ApproveRequestSchema>;
export const InvalidateRequestSchema = obj({
  schema_version: Type.Literal(1),
  client_request_id: Id,
  task_id: Id,
  plan_id: Id,
  expected_plan_revision: Type.Integer({ minimum: 1 }),
  reason: Type.Union([
    Type.Literal('PROFILE_CHANGED'),
    Type.Literal('PAGE_CHANGED'),
    Type.Literal('USER_CANCELLED'),
  ]),
});
export const ExecutionReportSchema = obj({
  execution_id: Id,
  started_at: Type.Integer(),
  ended_at: Type.Integer(),
  field_results: Type.Array(
    obj({
      field_id: Id,
      before: FieldValueSchema,
      target: FieldValueSchema,
      actual: FieldValueSchema,
      status: Type.Union([
        Type.Literal('verified'),
        Type.Literal('failed'),
        Type.Literal('manual'),
      ]),
      error_code: nullable(text(80)),
    }),
    { maxItems: 250 },
  ),
});
export const VerifyRequestSchema = obj({
  schema_version: Type.Literal(1),
  client_request_id: Id,
  task_id: Id,
  plan_id: Id,
  plan_revision: Type.Integer({ minimum: 1 }),
  form_snapshot_id: Id,
  user_approval: ApprovalSchema,
  execution_report: ExecutionReportSchema,
});
export type VerifyRequest = Static<typeof VerifyRequestSchema>;
export const VerifyResultSchema = obj({
  verified_fields: Type.Array(Id, { maxItems: 250 }),
  failed_fields: Type.Array(Id, { maxItems: 250 }),
  remaining_manual_fields: Type.Array(Id, { maxItems: 250 }),
  status: Type.Literal('REVIEW'),
  application_submitted: Type.Literal(false),
});
export type ExecutionReport = Static<typeof ExecutionReportSchema>;
export type ExecutionFieldResult = ExecutionReport['field_results'][number];
export type VerifyResult = Static<typeof VerifyResultSchema>;
export const ExecutionActionSchema = Type.Union([
  Type.Literal('fill'),
  Type.Literal('retry'),
  Type.Literal('undo'),
]);
export const ExecutionItemSchema = obj({
  field: ScannedFieldSchema,
  before: FieldValueSchema,
  target: FieldValueSchema,
  restore: FieldValueSchema,
});
export const ExecutionPacketSchema = obj({
  execution_id: Id,
  execution_epoch: Type.Integer({ minimum: 1 }),
  lease_token: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  task_id: Id,
  plan_id: Id,
  plan_revision: Type.Integer({ minimum: 1 }),
  plan_digest: digest,
  profile_revision: Type.Integer({ minimum: 0 }),
  snapshot_ref: ScanRefSchema,
  observed_snapshot_ref: ScanRefSchema,
  action: ExecutionActionSchema,
  source_execution_id: nullable(Id),
  expires_at: Type.Integer(),
  items: Type.Array(ExecutionItemSchema, { minItems: 1, maxItems: 250 }),
});
export type ExecutionPacket = Static<typeof ExecutionPacketSchema>;
export const ExecutionViewSchema = obj({
  packet: ExecutionPacketSchema,
  sequence: Type.Integer({ minimum: 0 }),
  phase: Type.Union([
    Type.Literal('created'),
    Type.Literal('before'),
    Type.Literal('after'),
    Type.Literal('completed'),
    Type.Literal('interrupted'),
  ]),
  pending_field_id: nullable(Id),
  report: ExecutionReportSchema,
  written_field_ids: Type.Array(Id, { maxItems: 250 }),
  cancelled: Type.Boolean(),
  verify_result: Type.Optional(nullable(VerifyResultSchema)),
});
export type ExecutionView = Static<typeof ExecutionViewSchema>;
export const BeginExecutionSchema = obj({
  schema_version: Type.Literal(1),
  client_request_id: Id,
  task_id: Id,
  plan_id: Id,
  expected_plan_revision: Type.Integer({ minimum: 1 }),
  plan_digest: digest,
  action: ExecutionActionSchema,
  source_execution_id: nullable(Id),
  field_ids: Type.Array(Id, { minItems: 1, maxItems: 250 }),
  observed_profile_revision: Type.Integer({ minimum: 0 }),
  observed_snapshot_ref: ScanRefSchema,
  observed_at: Type.Integer(),
});
export type BeginExecution = Static<typeof BeginExecutionSchema>;
export const ExecutionCheckpointSchema = obj({
  schema_version: Type.Literal(1),
  client_request_id: Id,
  task_id: Id,
  execution_id: Id,
  execution_epoch: Type.Integer({ minimum: 1 }),
  lease_token: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  sequence: Type.Integer({ minimum: 1 }),
  phase: Type.Union([
    Type.Literal('before'),
    Type.Literal('after'),
    Type.Literal('completed'),
    Type.Literal('interrupted'),
  ]),
  observed_snapshot_ref: ScanRefSchema,
  field_result: nullable(ExecutionReportSchema.properties.field_results.items),
  report: nullable(ExecutionReportSchema),
  written_field_ids: Type.Array(Id, { maxItems: 250 }),
});
export type ExecutionCheckpoint = Static<typeof ExecutionCheckpointSchema>;
export const ExecutionCancelSchema = obj({
  schema_version: Type.Literal(1),
  client_request_id: Id,
  task_id: Id,
  execution_id: Id,
});
export const BrowserExecutionStateSchema = obj({
  execution_id: Id,
  execution_epoch: Type.Integer({ minimum: 1 }),
  running: Type.Boolean(),
  sequence: Type.Integer({ minimum: 0 }),
  report: ExecutionReportSchema,
  written_field_ids: Type.Array(Id, { maxItems: 250 }),
  last_error: nullable(text(80)),
});
export type BrowserExecutionState = Static<typeof BrowserExecutionStateSchema>;
export const LocalFillTaskSchema = obj({
  task_id: Id,
  latest: FillPlanViewSchema,
  history: Type.Array(FillPlanViewSchema, { maxItems: 40 }),
  invalid_reason: nullable(text(80)),
  saved_at: Type.Integer(),
  executions: Type.Optional(Type.Array(ExecutionViewSchema, { maxItems: 20 })),
});
export type LocalFillTask = Static<typeof LocalFillTaskSchema>;
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('INVALID_REQUEST');
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v))
        .join(',') +
      '}'
    );
  throw new Error('INVALID_REQUEST');
}
export async function hashJson(value: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonicalJson(value)),
      ),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
export function planConsentPayload(
  request: Omit<FillPlanRequest, 'consent'> | FillPlanRequest,
) {
  return Object.fromEntries(
    Object.entries(request).filter(([key]) => key !== 'consent'),
  );
}
export function digestiblePlan(plan: FillPlan) {
  return Object.fromEntries(
    Object.entries(plan).filter(
      ([key]) => !['plan_digest', 'duration_ms', 'usage'].includes(key),
    ),
  );
}

export function sameExecutionScope(
  a: Static<typeof ScanRefSchema>,
  b: Static<typeof ScanRefSchema>,
) {
  return (
    a.task_id === b.task_id &&
    a.tab_id === b.tab_id &&
    a.frame_id === b.frame_id &&
    a.page_instance_id === b.page_instance_id &&
    a.dom_fingerprint === b.dom_fingerprint
  );
}
export function corePlan(view: FillPlanView): FillPlan {
  return Object.fromEntries(
    Object.keys(FillPlanSchema.properties).map((k) => [
      k,
      view[k as keyof FillPlan],
    ]),
  ) as FillPlan;
}
