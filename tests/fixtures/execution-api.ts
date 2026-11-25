import { createApp } from '../../apps/api/src/app';
import { planningRequest } from './planning';
import {
  hashJson,
  planConsentPayload,
  type FillPlanView,
  type ExecutionView,
  type ExecutionCheckpoint,
  type ExecutionFieldResult,
} from '@formpilot/contracts';
export const executionToken = 'm4-test-api-token';
export function executionApp(options: Parameters<typeof createApp>[0] = {}) {
  return createApp({
    apiToken: executionToken,
    provider: {
      name: 'deepseek',
      model: 'test-model',
      policyURL: 'https://example.test/policy',
      async generate() {
        return {
          output: { mappings: [] },
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
    },
    ...options,
  });
}
export async function executionSession(
  app: ReturnType<typeof createApp>,
  workspace = 'execution-workspace',
) {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: { authorization: 'Bearer ' + executionToken },
    payload: { workspace_id: workspace },
  });
  return { authorization: 'Bearer ' + r.json().data.session_token };
}
export function executionPost<T extends { client_request_id: string }>(
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
  path: string,
  body: T,
) {
  return app.inject({
    method: 'POST',
    url: '/v1/fill/' + path,
    headers: { ...headers, 'idempotency-key': body.client_request_id },
    payload: body,
  });
}
export async function approvedExecutionPlan(
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
  task = 'task-1',
) {
  const r = await planningRequest();
  r.task_id = task;
  r.form_snapshot.task_id = task;
  r.consent.payload_hash = await hashJson(planConsentPayload(r));
  const p = (await executionPost(app, headers, 'plan', r)).json()
    .data as FillPlanView;
  const v = await executionPost(app, headers, 'approve', {
    schema_version: 1,
    client_request_id: crypto.randomUUID(),
    task_id: p.task_id,
    plan_id: p.plan_id,
    expected_plan_revision: p.plan_revision,
    plan_digest: p.plan_digest,
    approved_field_ids: p.field_decisions
      .filter((f) => f.decision === 'fill')
      .map((f) => f.field_id),
    observed_profile_revision: p.profile_revision,
    observed_snapshot_ref: p.snapshot_ref,
    observed_at: Date.now(),
  });
  return v.json().data as FillPlanView;
}
export const beginExecution = (p: FillPlanView) => ({
  schema_version: 1,
  client_request_id: crypto.randomUUID(),
  task_id: p.task_id,
  plan_id: p.plan_id,
  expected_plan_revision: p.plan_revision,
  plan_digest: p.plan_digest,
  action: 'fill' as const,
  source_execution_id: null,
  field_ids: p.user_approval!.approved_field_ids,
  observed_profile_revision: p.profile_revision,
  observed_snapshot_ref: p.snapshot_ref,
  observed_at: Date.now(),
});
export function executionStep(
  e: ExecutionView,
  phase: ExecutionCheckpoint['phase'],
  row: ExecutionFieldResult | null = null,
): ExecutionCheckpoint {
  return {
    schema_version: 1,
    client_request_id: crypto.randomUUID(),
    task_id: e.packet.task_id,
    execution_id: e.packet.execution_id,
    execution_epoch: e.packet.execution_epoch,
    lease_token: e.packet.lease_token,
    sequence: e.sequence + 1,
    phase,
    observed_snapshot_ref: e.packet.observed_snapshot_ref,
    field_result: row,
    report: ['completed', 'interrupted'].includes(phase)
      ? { ...e.report, ended_at: Date.now() }
      : null,
    written_field_ids: e.written_field_ids,
  };
}
export async function completedExecution(
  app: ReturnType<typeof createApp>,
  h: Record<string, string>,
  e: ExecutionView,
) {
  const item = e.packet.items[0]!,
    row: ExecutionFieldResult = {
      field_id: item.field.field_id,
      before: item.before,
      target: item.target,
      actual: item.before,
      status: 'failed',
      error_code: 'EXECUTION_INTERRUPTED',
    };
  let result = await executionPost(
    app,
    h,
    'executions/checkpoint',
    executionStep(e, 'before', row),
  );
  if (result.statusCode !== 200) throw new Error(result.body);
  e = result.json().data;
  const after = executionStep(e, 'after', {
    ...row,
    actual: row.target,
    status: 'verified',
    error_code: null,
  });
  after.written_field_ids = [row.field_id];
  result = await executionPost(app, h, 'executions/checkpoint', after);
  if (result.statusCode !== 200) throw new Error(result.body);
  e = result.json().data;
  result = await executionPost(
    app,
    h,
    'executions/checkpoint',
    executionStep(e, 'completed'),
  );
  if (result.statusCode !== 200) throw new Error(result.body);
  return result.json().data as ExecutionView;
}
export const verification = (p: FillPlanView, e: ExecutionView) => ({
  schema_version: 1 as const,
  client_request_id: crypto.randomUUID(),
  task_id: p.task_id,
  plan_id: p.plan_id,
  plan_revision: p.plan_revision,
  form_snapshot_id: p.form_snapshot_id,
  user_approval: p.user_approval!,
  execution_report: e.report,
});
