export * from './profile';
export * from './scan';
export * from './fill';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
export const PROTOCOL_VERSION = '1' as const;
export const API_ORIGIN = 'http://127.0.0.1:4318';
export const WEB_ORIGIN = 'http://localhost:3000';
const ERROR_CODES = [
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'SCOPE_DENIED',
  'CONSENT_REQUIRED',
  'REFERENCE_NOT_FOUND',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'MODEL_UNAVAILABLE',
  'REVISION_CONFLICT',
  'STALE_PLAN',
  'IDEMPOTENCY_CONFLICT',
  'UNSUPPORTED_DOCUMENT',
  'EVIDENCE_INVALID',
  'RULE_VIOLATION',
  'MODEL_INVALID_OUTPUT',
  'MODEL_TIMEOUT',
  'MODEL_REFUSED',
  'PAGE_CHANGED',
  'STALE_SNAPSHOT',
  'FIELD_NOT_FOUND',
  'PERMISSION_DENIED',
  'UNSUPPORTED_PAGE',
  'SCAN_LIMIT_EXCEEDED',
  'SNAPSHOT_EXPIRED',
  'EXECUTION_NOT_AVAILABLE',
  'STORAGE_UNAVAILABLE',
  'TASK_INTERRUPTED',
  'EXECUTION_LOCKED',
  'EXECUTION_EXPIRED',
  'USER_CHANGED',
  'VALUE_NOT_PERSISTED',
  'SITE_VALIDATION_FAILED',
  'CONTROL_UNSUPPORTED',
  'LOCATOR_NOT_FOUND',
  'EXECUTION_INTERRUPTED',
] as const;
export const ErrorCodeSchema = Type.Union(
  ERROR_CODES.map((code) => Type.Literal(code)),
);
export type ErrorCode = Static<typeof ErrorCodeSchema>;
export const ErrorSchema = Type.Object(
  {
    code: ErrorCodeSchema,
    message: Type.String({ maxLength: 200 }),
    retryable: Type.Boolean(),
    details: Type.Object({}, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
export const HealthSchema = Type.Object(
  {
    status: Type.Literal('ok'),
    service: Type.Literal('formpilot-api'),
    protocol_version: Type.Literal(PROTOCOL_VERSION),
  },
  { additionalProperties: false },
);
export const CapabilitiesSchema = Type.Object(
  {
    stage: Type.Union([
      Type.Literal('M0'),
      Type.Literal('M1'),
      Type.Literal('M3'),
      Type.Literal('M4'),
      Type.Literal('M5.1'),
      Type.Literal('M5.2'),
      Type.Literal('M5.3'),
    ]),
    model_available: Type.Boolean(),
    planning_available: Type.Optional(Type.Boolean()),
    execution_available: Type.Optional(Type.Boolean()),
    career_available: Type.Optional(Type.Boolean()),
    operations: Type.Array(
      Type.Union([
        Type.Literal('health'),
        Type.Literal('profile_parse'),
        Type.Literal('fill_plan'),
        Type.Literal('resolve'),
        Type.Literal('fill_execute'),
        Type.Literal('fill_verify'),
        Type.Literal('jd_parse'),
        Type.Literal('job_match_local'),
        Type.Literal('resume_tailor_local'),
        Type.Literal('answer_generate'),
      ]),
      { maxItems: 10 },
    ),
    provider: Type.String({ maxLength: 80 }),
    model: Type.String({ maxLength: 100 }),
    policy_url: Type.String({ maxLength: 500 }),
  },
  { additionalProperties: false },
);
export const envelope = <T extends import('@sinclair/typebox').TSchema>(
  data: T,
) =>
  Type.Object(
    {
      request_id: Type.String({ maxLength: 64 }),
      data: Type.Union([data, Type.Null()]),
      error: Type.Union([ErrorSchema, Type.Null()]),
    },
    { additionalProperties: false },
  );
const id = Type.String({ pattern: '^[a-zA-Z0-9-]{1,64}$' });
const base = {
  protocol_version: Type.Literal(PROTOCOL_VERSION),
  request_id: id,
  task_id: Type.Null(),
};
export const MessageSchema = Type.Union([
  Type.Object(
    {
      ...base,
      method: Type.Literal('pair'),
      pairing_code: Type.String({ pattern: '^[a-f0-9]{32}$' }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...base,
      method: Type.Literal('ping'),
      session_token: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...base, method: Type.Literal('health') },
    { additionalProperties: false },
  ),
]);
export type Message = Static<typeof MessageSchema>;
export const isMessage = (value: unknown): value is Message =>
  Value.Check(MessageSchema, value);
export const HealthEnvelopeSchema = envelope(HealthSchema);
export const CapabilitiesEnvelopeSchema = envelope(CapabilitiesSchema);
export const FailureEnvelopeSchema = Type.Object(
  { request_id: Type.String(), data: Type.Null(), error: ErrorSchema },
  { additionalProperties: false },
);
export type HealthEnvelope = Static<typeof HealthEnvelopeSchema>;
export function failure(
  request_id: string,
  code: ErrorCode,
  message: string,
  retryable = false,
) {
  return {
    request_id,
    data: null,
    error: { code, message, retryable, details: {} },
  };
}
export function parseHealth(value: unknown): HealthEnvelope {
  if (
    !Value.Check(HealthEnvelopeSchema, value) ||
    value.data === null ||
    value.error !== null
  )
    throw new Error('API 返回了无效的健康检查结果');
  return value;
}

const PairDataSchema = Type.Object(
  {
    session_token: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    expires_at: Type.Number(),
  },
  { additionalProperties: false },
);
const PingDataSchema = Type.Object(
  {
    pong: Type.Literal(true),
    protocol_version: Type.Literal(PROTOCOL_VERSION),
    api_connected: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const BridgeResponseSchema = Type.Union([
  envelope(PairDataSchema),
  envelope(PingDataSchema),
]);
export interface BridgeResponse {
  request_id: string;
  data: {
    session_token?: string;
    expires_at?: number;
    pong?: true;
    protocol_version?: '1';
    api_connected?: boolean;
  } | null;
  error: { message: string } | null;
}
export function parseBridgeResponse(
  value: unknown,
  requestId: string,
): BridgeResponse {
  if (
    !Value.Check(BridgeResponseSchema, value) ||
    value.request_id !== requestId ||
    (value.data === null) === (value.error === null)
  )
    throw new Error('扩展响应无效');
  return value;
}
export * from './execution-messages';
export * from './career';

export * from './resume';

export * from './answer';
