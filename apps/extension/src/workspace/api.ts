import {
  API_ORIGIN,
  AnswerTaskSchema,
  type AnswerRequest,
  JobParseTaskSchema,
  type JobParseRequest,
  ExecutionViewSchema,
  VerifyResultSchema,
  type ExecutionView,
  type VerifyRequest,
  FillPlanViewSchema,
  CapabilitiesSchema,
  JobSchema,
  SessionSchema,
  type ParseRequest,
  type ParseJob,
  type ParseResult,
} from '@formpilot/contracts';
import { Value } from '@sinclair/typebox/value';
export interface ApiSession {
  session_token: string;
  expires_at: number;
}
async function json(path: string, options: RequestInit = {}) {
  const response = await fetch(API_ORIGIN + path, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(5000),
    redirect: 'error',
    cache: 'no-store',
  });
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== 'object' ||
    !('data' in body) ||
    !('error' in body)
  )
    throw new Error('API 响应无效');
  const envelope = body as {
    data: unknown;
    error: { message?: string; code?: string } | null;
  };
  if (!response.ok || envelope.error)
    throw new Error(
      envelope.error?.code === 'REFERENCE_NOT_FOUND'
        ? '任务已过期或服务已重启，请重新解析'
        : (envelope.error?.message ?? 'API 请求失败'),
    );
  return envelope.data;
}
export async function capabilities() {
  const data = await json('/v1/system/capabilities');
  if (!Value.Check(CapabilitiesSchema, data)) throw new Error('能力信息无效');
  return data;
}
export async function createSession(workspace_id: string, token: string) {
  const data = await json('/v1/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify({ workspace_id }),
  });
  if (!Value.Check(SessionSchema, data)) throw new Error('会话响应无效');
  await chrome.storage.session.set({ ['api_' + workspace_id]: data });
  return data;
}
export async function loadSession(
  workspace_id: string,
): Promise<ApiSession | null> {
  const stored = (await chrome.storage.session.get('api_' + workspace_id))[
    'api_' + workspace_id
  ];
  return Value.Check(SessionSchema, stored) && stored.expires_at > Date.now()
    ? stored
    : null;
}
const headers = (session: ApiSession) => ({
  Authorization: 'Bearer ' + session.session_token,
});
export async function startParse(
  request: ParseRequest,
  session: ApiSession,
): Promise<ParseJob> {
  const data = await json('/v1/profile/parse', {
    method: 'POST',
    headers: { ...headers(session), 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!Value.Check(JobSchema, data)) throw new Error('解析任务响应无效');
  return data;
}
export async function pollParse(
  id: string,
  session: ApiSession,
): Promise<ParseJob> {
  const data = await json('/v1/profile/parse/jobs/' + encodeURIComponent(id), {
    headers: headers(session),
  });
  if (!Value.Check(JobSchema, data)) throw new Error('解析状态无效');
  return data;
}
export async function deleteJob(id: string, session: ApiSession) {
  await json('/v1/profile/parse/jobs/' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: headers(session),
  });
}
export async function revokeSession(workspace_id: string, session: ApiSession) {
  await json('/v1/sessions/current', {
    method: 'DELETE',
    headers: headers(session),
  });
  await chrome.storage.session.remove('api_' + workspace_id);
}
export type ModelResult = ParseResult;

export async function planOperation(
  path: string,
  request: { client_request_id: string },
  session: ApiSession,
) {
  const data = await json('/v1/fill/' + path, {
    method: 'POST',
    headers: {
      ...headers(session),
      'Content-Type': 'application/json',
      'Idempotency-Key': request.client_request_id,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(35000),
  });
  if (!Value.Check(FillPlanViewSchema, data)) throw new Error('计划响应无效');
  return data;
}
export async function getPlan(task: string, session: ApiSession) {
  const data = await json('/v1/fill/tasks/' + encodeURIComponent(task), {
    headers: headers(session),
  });
  if (!Value.Check(FillPlanViewSchema, data)) throw new Error('计划响应无效');
  return data;
}

export async function executionOperation<
  T extends { client_request_id: string },
>(path: string, request: T, session: ApiSession) {
  const data = await json('/v1/fill/' + path, {
    method: 'POST',
    headers: {
      ...headers(session),
      'Content-Type': 'application/json',
      'Idempotency-Key': request.client_request_id,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(12000),
  });
  if (!Value.Check(ExecutionViewSchema, data))
    throw new Error('执行状态响应无效');
  return data;
}
export async function executions(task: string, session: ApiSession) {
  const data = await json(
    '/v1/fill/tasks/' + encodeURIComponent(task) + '/executions',
    { headers: headers(session) },
  );
  if (
    !Array.isArray(data) ||
    data.length > 20 ||
    !data.every((e) => Value.Check(ExecutionViewSchema, e))
  )
    throw new Error('执行记录响应无效');
  return data as ExecutionView[];
}
export async function verifyExecution(
  request: VerifyRequest,
  session: ApiSession,
) {
  const data = await json('/v1/fill/verify', {
    method: 'POST',
    headers: {
      ...headers(session),
      'Content-Type': 'application/json',
      'Idempotency-Key': request.client_request_id,
    },
    body: JSON.stringify(request),
  });
  if (!Value.Check(VerifyResultSchema, data))
    throw new Error('核验结果响应无效');
  return data;
}

export async function startJobParse(
  request: JobParseRequest,
  session: ApiSession,
) {
  const data = await json('/v1/career/jd/parse', {
    method: 'POST',
    headers: {
      ...headers(session),
      'Content-Type': 'application/json',
      'Idempotency-Key': request.client_request_id,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(12000),
  });
  if (!Value.Check(JobParseTaskSchema, data))
    throw new Error('JD 任务响应无效');
  return data;
}
export async function pollJobParse(id: string, session: ApiSession) {
  const data = await json('/v1/career/jd/jobs/' + encodeURIComponent(id), {
    headers: headers(session),
  });
  if (!Value.Check(JobParseTaskSchema, data))
    throw new Error('JD 任务响应无效');
  return data;
}
export async function deleteJobParse(id: string, session: ApiSession) {
  await json('/v1/career/jd/jobs/' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: headers(session),
  });
}

export async function startAnswer(request: AnswerRequest, session: ApiSession) {
  const data = await json('/v1/career/answers/generate', {
    method: 'POST',
    headers: {
      ...headers(session),
      'Content-Type': 'application/json',
      'Idempotency-Key': request.client_request_id,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(12000),
  });
  if (!Value.Check(AnswerTaskSchema, data))
    throw new Error('开放题任务响应无效');
  return data;
}
export async function pollAnswer(id: string, session: ApiSession) {
  const data = await json('/v1/career/answers/jobs/' + encodeURIComponent(id), {
    headers: headers(session),
  });
  if (!Value.Check(AnswerTaskSchema, data))
    throw new Error('开放题任务响应无效');
  return data;
}
export async function deleteAnswerJob(id: string, session: ApiSession) {
  await json('/v1/career/answers/jobs/' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: headers(session),
  });
}

export async function findAnswerRequest(id: string, session: ApiSession) {
  const data = await json(
    '/v1/career/answers/requests/' + encodeURIComponent(id),
    { headers: headers(session) },
  );
  if (!Value.Check(AnswerTaskSchema, data))
    throw new Error('开放题任务响应无效');
  return data;
}
