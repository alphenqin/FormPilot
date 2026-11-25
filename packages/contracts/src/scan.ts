import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
const object = <T extends import('@sinclair/typebox').TProperties>(
  properties: T,
) => Type.Object(properties, { additionalProperties: false });
const id = Type.String({ pattern: '^[a-zA-Z0-9-]{1,80}$' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const text = (max = 200) => Type.String({ maxLength: max });
export const ScanRefSchema = object({
  task_id: id,
  tab_id: Type.Integer({ minimum: 0 }),
  frame_id: Type.Literal(0),
  page_instance_id: id,
  form_snapshot_id: id,
  dom_fingerprint: hash,
});
export type ScanRef = Static<typeof ScanRefSchema>;
export const FieldOptionSchema = object({
  value: text(4096),
  label: text(200),
  disabled: Type.Boolean(),
});
export const FieldConstraintsSchema = object({
  min: Type.Union([text(200), Type.Null()]),
  max: Type.Union([text(200), Type.Null()]),
  step: Type.Union([text(100), Type.Null()]),
  pattern: Type.Union([text(500), Type.Null()]),
  min_length: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  max_length: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  accept: Type.Union([text(500), Type.Null()]),
  multiple: Type.Boolean(),
});
export const ScannedFieldSchema = object({
  field_id: id,
  locator_ref: id,
  group_id: id,
  form_id: id,
  label: text(),
  label_source: text(40),
  manual_label: Type.Union([text(), Type.Null()]),
  description: text(500),
  name: text(),
  html_id: text(),
  placeholder: text(),
  control_type: text(40),
  required: Type.Boolean(),
  visible: Type.Literal(true),
  enabled: Type.Boolean(),
  read_only: Type.Boolean(),
  supported: Type.Boolean(),
  manual_reason: Type.Union([text(80), Type.Null()]),
  current_value: Type.Union([
    text(4096),
    Type.Boolean(),
    Type.Array(text(4096), { maxItems: 200 }),
    Type.Null(),
  ]),
  options: Type.Array(FieldOptionSchema, { maxItems: 200 }),
  option_count: Type.Integer({ minimum: 0 }),
  constraints: FieldConstraintsSchema,
});
export type ScannedField = Static<typeof ScannedFieldSchema>;
export const ScanGroupSchema = object({
  group_id: id,
  form_id: id,
  label: text(),
  parent_group_id: Type.Union([id, Type.Null()]),
});
export type ScanGroup = Static<typeof ScanGroupSchema>;
export const ScanWarningSchema = object({
  code: text(80),
  count: Type.Integer({ minimum: 0 }),
});
export const FormSnapshotSchema = object({
  ...ScanRefSchema.properties,
  protocol_version: Type.Literal('1'),
  snapshot_revision: Type.Integer({ minimum: 1 }),
  origin: text(300),
  route: text(300),
  adapter_version: text(50),
  site_id: text(50),
  captured_at: Type.Integer({ minimum: 0 }),
  duration_ms: Type.Number({ minimum: 0 }),
  complete: Type.Boolean(),
  fields: Type.Array(ScannedFieldSchema, { maxItems: 250 }),
  groups: Type.Array(ScanGroupSchema, { maxItems: 500 }),
  warnings: Type.Array(ScanWarningSchema, { maxItems: 30 }),
  excluded: object({
    hidden: Type.Integer({ minimum: 0 }),
    sensitive: Type.Integer({ minimum: 0 }),
    actions: Type.Integer({ minimum: 0 }),
  }),
});
export type FormSnapshot = Static<typeof FormSnapshotSchema>;
export const ScanSessionSchema = object({
  task_id: id,
  tab_id: Type.Integer({ minimum: 0 }),
  started_at: Type.Integer(),
  expires_at: Type.Integer(),
});
export type ScanSession = Static<typeof ScanSessionSchema>;
const base = { protocol_version: Type.Literal('1'), request_id: id };
export const ScanUiMessageSchema = Type.Union([
  object({
    ...base,
    task_id: Type.Null(),
    method: Type.Literal('scan.start'),
    tab_id: Type.Integer({ minimum: 0 }),
  }),
  object({ ...base, task_id: Type.Null(), method: Type.Literal('scan.get') }),
  object({
    ...base,
    task_id: id,
    method: Type.Union([
      Type.Literal('scan.refresh'),
      Type.Literal('scan.stop'),
    ]),
    tab_id: Type.Integer({ minimum: 0 }),
  }),
  object({
    ...base,
    task_id: id,
    method: Type.Literal('scan.locate'),
    ref: ScanRefSchema,
    field_id: id,
  }),
  object({
    ...base,
    task_id: id,
    method: Type.Literal('scan.annotate'),
    ref: ScanRefSchema,
    field_id: id,
    label: Type.String({ minLength: 1, maxLength: 200 }),
  }),
]);
export type ScanUiMessage = Static<typeof ScanUiMessageSchema>;
export const isScanUiMessage = (input: unknown): input is ScanUiMessage =>
  Value.Check(ScanUiMessageSchema, input);
export const ScanContentMessageSchema = Type.Union([
  object({
    ...base,
    task_id: id,
    method: Type.Literal('scan.initialize'),
    session: ScanSessionSchema,
  }),
  object({
    ...base,
    task_id: id,
    method: Type.Union([
      Type.Literal('scan.read'),
      Type.Literal('scan.refresh'),
      Type.Literal('scan.stop'),
    ]),
  }),
  object({
    ...base,
    task_id: id,
    method: Type.Literal('scan.locate'),
    ref: ScanRefSchema,
    field_id: id,
  }),
  object({
    ...base,
    task_id: id,
    method: Type.Literal('scan.annotate'),
    ref: ScanRefSchema,
    field_id: id,
    label: Type.String({ minLength: 1, maxLength: 200 }),
  }),
]);
export const isScanContentMessage = (
  input: unknown,
): input is Static<typeof ScanContentMessageSchema> =>
  Value.Check(ScanContentMessageSchema, input);
export const LocateResultSchema = object({
  field_id: id,
  matched: Type.Literal(true),
  rect: object({
    x: Type.Number(),
    y: Type.Number(),
    width: Type.Number(),
    height: Type.Number(),
  }),
});
export const ScanDataSchema = object({
  session: Type.Union([ScanSessionSchema, Type.Null()]),
  snapshot: Type.Union([FormSnapshotSchema, Type.Null()]),
  status: Type.Union(
    ['idle', 'active', 'stale', 'unavailable'].map((s) => Type.Literal(s)),
  ),
});
export type ScanData = Static<typeof ScanDataSchema>;
export function snapshotRef(snapshot: FormSnapshot): ScanRef {
  return {
    task_id: snapshot.task_id,
    tab_id: snapshot.tab_id,
    frame_id: 0,
    page_instance_id: snapshot.page_instance_id,
    form_snapshot_id: snapshot.form_snapshot_id,
    dom_fingerprint: snapshot.dom_fingerprint,
  };
}
