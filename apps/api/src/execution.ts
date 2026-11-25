import { randomUUID, randomBytes } from 'node:crypto';
import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  BeginExecutionSchema,
  ExecutionCheckpointSchema,
  ExecutionCancelSchema,
  ExecutionViewSchema,
  VerifyRequestSchema,
  canonicalJson,
  sameExecutionScope,
  failure,
  type BeginExecution,
  type ExecutionCheckpoint,
  type ExecutionPacket,
  type ExecutionView,
  type VerifyRequest,
  type VerifyResult,
  type ErrorCode,
} from '@formpilot/contracts';
import { PlanningFault, verifyExecution } from '@formpilot/domain';
import type { PlanStore, StoredPlan } from './plan-store';
type Auth = (
  req: FastifyRequest,
  reply: FastifyReply,
) => { workspace_id: string } | null;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function fail(code: ErrorCode): never {
  throw new PlanningFault(code);
}
const requestHash = async (path: string, body: unknown) => {
  const { hashJson } = await import('@formpilot/contracts');
  return hashJson({ path, body });
};
export function registerExecution(
  app: FastifyInstance,
  auth: Auth,
  store: PlanStore | null,
) {
  const pending = new Map<
    string,
    { hash: string; work: Promise<ExecutionView | VerifyResult> }
  >();
  const record = (owner: string, task: string) => {
    const r = store!.get(owner, task);
    if (!r) fail('REFERENCE_NOT_FOUND');
    return r;
  };
  function find(r: StoredPlan, id: string) {
    const e = r.executions?.find((e) => e.packet.execution_id === id);
    if (!e) fail('REFERENCE_NOT_FOUND');
    return structuredClone(e);
  }
  function save(
    owner: string,
    old: StoredPlan,
    e: ExecutionView,
    op: string,
    response: ExecutionView | VerifyResult = e,
    release = false,
    acquire = false,
  ) {
    if (!Value.Check(ExecutionViewSchema, e)) fail('RULE_VIOLATION');
    const next = {
      ...old,
      executions: [
        ...(old.executions ?? []).filter(
          (x) => x.packet.execution_id !== e.packet.execution_id,
        ),
        e,
      ].slice(-20),
      execution_epoch: Math.max(
        old.execution_epoch ?? 0,
        e.packet.execution_epoch,
      ),
      view: { ...old.view, state_revision: old.view.state_revision + 1 },
    };
    store!.put(
      owner,
      old.view.task_id,
      old.view.state_revision,
      next,
      op,
      response,
      acquire
        ? {
            acquire: {
              execution_id: e.packet.execution_id,
              expires_at: e.packet.expires_at,
            },
          }
        : release
          ? { release: e.packet.execution_id }
          : undefined,
    );
    return response;
  }
  function route(
    path: string,
    schema: TSchema,
    operation: (
      owner: string,
      body: never,
    ) => Promise<ExecutionView | VerifyResult>,
  ) {
    app.post(
      path,
      { bodyLimit: 8388608, schema: { body: schema } },
      async (req, reply) => {
        const session = auth(req, reply);
        if (!session) return;
        if (!store)
          return reply
            .status(503)
            .send(
              failure(req.id, 'STORAGE_UNAVAILABLE', '执行检查点存储不可用'),
            );
        const body = req.body as { client_request_id: string; task_id: string };
        try {
          if (req.headers['idempotency-key'] !== body.client_request_id)
            fail('INVALID_REQUEST');
          const owner = session.workspace_id,
            key = owner + ':' + body.client_request_id,
            hash = await requestHash(path, body),
            active = pending.get(key);
          if (active && active.hash !== hash) fail('IDEMPOTENCY_CONFLICT');
          let result: ExecutionView | VerifyResult;
          if (active) result = await active.work;
          else {
            const replay = store.reserve<ExecutionView | VerifyResult>(
              owner,
              body.client_request_id,
              hash,
            );
            if (replay) {
              result =
                'packet' in replay
                  ? find(
                      record(owner, body.task_id),
                      replay.packet.execution_id,
                    )
                  : replay;
            } else {
              const work = operation(owner, body as never);
              pending.set(key, { hash, work });
              try {
                result = await work;
              } finally {
                pending.delete(key);
              }
            }
          }
          return { request_id: req.id, data: result, error: null };
        } catch (error) {
          const known = [
            'REVISION_CONFLICT',
            'IDEMPOTENCY_CONFLICT',
            'TASK_INTERRUPTED',
            'EXECUTION_LOCKED',
            'RATE_LIMITED',
          ];
          const code: ErrorCode =
            error instanceof PlanningFault
              ? error.code
              : error instanceof Error && known.includes(error.message)
                ? (error.message as ErrorCode)
                : 'INTERNAL_ERROR';
          return reply
            .status(
              code === 'INTERNAL_ERROR'
                ? 500
                : code === 'REFERENCE_NOT_FOUND'
                  ? 404
                  : code === 'UNAUTHORIZED'
                    ? 401
                    : code === 'SCOPE_DENIED'
                      ? 403
                      : 409,
            )
            .send(failure(req.id, code, '执行操作未完成：' + code));
        }
      },
    );
  }
  route(
    '/v1/fill/executions/begin',
    BeginExecutionSchema,
    async (owner, body: BeginExecution) => {
      const old = record(owner, body.task_id),
        v = old.view;
      if (
        v.plan_id !== body.plan_id ||
        v.plan_revision !== body.expected_plan_revision ||
        v.plan_digest !== body.plan_digest ||
        body.observed_profile_revision !== v.profile_revision ||
        Math.abs(Date.now() - body.observed_at) > 10000 ||
        !sameExecutionScope(body.observed_snapshot_ref, v.snapshot_ref)
      )
        fail('STALE_PLAN');
      if (new Set(body.field_ids).size !== body.field_ids.length)
        fail('RULE_VIOLATION');
      let source: ExecutionView | null = null;
      if (body.source_execution_id) {
        source = find(old, body.source_execution_id);
        if (
          source.packet.plan_id !== v.plan_id ||
          !['completed', 'interrupted'].includes(source.phase)
        )
          fail('STALE_PLAN');
      }
      if (body.action === 'fill') {
        if (
          body.source_execution_id ||
          v.status !== 'READY' ||
          v.invalid_reason ||
          !v.user_approval ||
          !same(body.observed_snapshot_ref, v.snapshot_ref) ||
          (old.executions ?? []).some(
            (e) => e.packet.plan_id === v.plan_id && e.packet.action === 'fill',
          )
        )
          fail('STALE_PLAN');
      } else if (body.action === 'retry') {
        if (
          !source ||
          source.packet.action === 'undo' ||
          v.status !== 'REVIEW' ||
          v.invalid_reason ||
          !v.user_approval ||
          body.field_ids.length !== 1 ||
          !source.report.field_results.some(
            (r) => r.field_id === body.field_ids[0] && r.status === 'failed',
          )
        )
          fail('STALE_PLAN');
      } else if (
        !source ||
        source.packet.action === 'undo' ||
        source.written_field_ids.length === 0 ||
        (old.executions ?? []).some(
          (e) =>
            e.packet.action === 'undo' &&
            e.packet.source_execution_id === source!.packet.execution_id,
        )
      )
        fail('RULE_VIOLATION');
      if (
        body.action !== 'undo' &&
        body.field_ids.some(
          (id) => !v.user_approval?.approved_field_ids.includes(id),
        )
      )
        fail('SCOPE_DENIED');
      const items = body.field_ids.map((id) => {
        const d = v.field_decisions.find((d) => d.field_id === id),
          field = old.context.input.form_snapshot.fields.find(
            (f) => f.field_id === id,
          );
        if (
          !d ||
          !field ||
          d.decision !== 'fill' ||
          d.target_value === null ||
          !field.supported ||
          !field.enabled ||
          field.read_only ||
          ['file', 'password', 'hidden', 'submit', 'button'].includes(
            field.control_type,
          )
        )
          fail('RULE_VIOLATION');
        const previous = source?.report.field_results.find(
          (f) => f.field_id === id,
        );
        if (
          body.action === 'undo' &&
          (!source!.written_field_ids.includes(id) || !previous)
        )
          fail('SCOPE_DENIED');
        if (body.action === 'retry' && !previous) fail('SCOPE_DENIED');
        return {
          field: structuredClone(field),
          before:
            body.action === 'undo'
              ? previous!.target
              : body.action === 'retry'
                ? previous!.actual
                : d.current_value,
          target: body.action === 'undo' ? d.current_value : d.target_value,
          restore: d.current_value,
        };
      });
      const now = Date.now(),
        packet: ExecutionPacket = {
          execution_id: randomUUID(),
          execution_epoch: (old.execution_epoch ?? 0) + 1,
          lease_token: randomBytes(32).toString('hex'),
          task_id: v.task_id,
          plan_id: v.plan_id,
          plan_revision: v.plan_revision,
          plan_digest: v.plan_digest,
          profile_revision: v.profile_revision,
          snapshot_ref: v.snapshot_ref,
          observed_snapshot_ref: body.observed_snapshot_ref,
          action: body.action,
          source_execution_id: body.source_execution_id,
          expires_at: Math.min(now + 600000, v.expires_at),
          items,
        };
      const e: ExecutionView = {
        packet,
        sequence: 0,
        phase: 'created',
        pending_field_id: null,
        report: {
          execution_id: packet.execution_id,
          started_at: now,
          ended_at: now,
          field_results: [],
        },
        written_field_ids: [],
        cancelled: false,
        verify_result: null,
      };
      const ready = { ...old, view: { ...v, status: 'WRITING' as const } };
      return save(owner, ready, e, body.client_request_id, e, false, true);
    },
  );
  route(
    '/v1/fill/executions/checkpoint',
    ExecutionCheckpointSchema,
    async (owner, body: ExecutionCheckpoint) => {
      const old = record(owner, body.task_id),
        e = find(old, body.execution_id),
        p = e.packet;
      if (
        body.execution_epoch !== p.execution_epoch ||
        body.lease_token !== p.lease_token ||
        body.sequence !== e.sequence + 1 ||
        ['completed', 'interrupted'].includes(e.phase)
      )
        fail('REVISION_CONFLICT');
      const preparedIds = e.report.field_results.map((f) => f.field_id);
      const valid =
        old.view.plan_id === p.plan_id &&
        old.view.plan_revision === p.plan_revision &&
        (p.action === 'undo' ||
          (!old.view.invalid_reason && !!old.view.user_approval));
      if (
        body.phase === 'before' &&
        (!valid ||
          e.cancelled ||
          p.expires_at < Date.now() ||
          !sameExecutionScope(body.observed_snapshot_ref, p.snapshot_ref))
      )
        fail('STALE_PLAN');
      const item =
        p.items[e.report.field_results.length - (e.pending_field_id ? 1 : 0)];
      if (body.phase === 'before' || body.phase === 'after') {
        const f = body.field_result;
        if (
          !f ||
          !item ||
          f.field_id !== item.field.field_id ||
          !same(f.before, item.before) ||
          !same(f.target, item.target) ||
          body.report !== null
        )
          fail('RULE_VIOLATION');
        if (body.phase === 'before') {
          if (
            e.pending_field_id ||
            e.phase === 'before' ||
            f.status !== 'failed' ||
            f.error_code !== 'EXECUTION_INTERRUPTED' ||
            !same(f.actual, f.before)
          )
            fail('RULE_VIOLATION');
          e.pending_field_id = f.field_id;
          e.report.field_results.push(f);
        } else {
          if (
            e.pending_field_id !== f.field_id ||
            (f.status === 'verified' &&
              (!same(f.actual, f.target) ||
                f.error_code !== null ||
                !sameExecutionScope(
                  body.observed_snapshot_ref,
                  p.snapshot_ref,
                )))
          )
            fail('RULE_VIOLATION');
          e.report.field_results[e.report.field_results.length - 1] = f;
          e.pending_field_id = null;
        }
      } else {
        const r = body.report;
        if (
          !r ||
          body.field_result !== null ||
          r.execution_id !== p.execution_id ||
          r.started_at !== e.report.started_at ||
          r.ended_at < r.started_at ||
          r.ended_at > Date.now() + 5000 ||
          r.field_results.length !== p.items.length
        )
          fail('RULE_VIOLATION');
        for (let i = 0; i < p.items.length; i++) {
          const row = r.field_results[i]!,
            expected = p.items[i]!,
            saved = e.report.field_results.find(
              (f) => f.field_id === row.field_id,
            );
          if (
            row.field_id !== expected.field.field_id ||
            !same(row.before, expected.before) ||
            !same(row.target, expected.target)
          )
            fail('RULE_VIOLATION');
          // Final read may only retain or downgrade a confirmed per-field checkpoint.
          if (
            row.status === 'verified' &&
            (!saved ||
              saved.status !== 'verified' ||
              !same(row.actual, row.target) ||
              row.error_code !== null ||
              !sameExecutionScope(body.observed_snapshot_ref, p.snapshot_ref))
          )
            fail('RULE_VIOLATION');
        }
        if (
          body.phase === 'completed' &&
          (e.pending_field_id ||
            e.report.field_results.length !== p.items.length)
        )
          fail('RULE_VIOLATION');
        e.report = r;
        e.pending_field_id = null;
      }
      const written = new Set(body.written_field_ids);
      if (
        written.size !== body.written_field_ids.length ||
        e.written_field_ids.some((id) => !written.has(id)) ||
        body.written_field_ids.some(
          (id) =>
            !preparedIds.includes(id) ||
            !p.items.some((i) => i.field.field_id === id),
        )
      )
        fail('RULE_VIOLATION');
      e.written_field_ids = body.written_field_ids;
      e.sequence = body.sequence;
      e.phase = body.phase;
      e.report.ended_at = Date.now();
      // Keep the browser's exact timestamp in final immutable report for verify.
      if (body.report) e.report.ended_at = body.report.ended_at;
      const done = ['completed', 'interrupted'].includes(e.phase);
      if (
        done &&
        e.report.field_results.some((r) =>
          [
            'PAGE_CHANGED',
            'STALE_SNAPSHOT',
            'SNAPSHOT_EXPIRED',
            'LOCATOR_NOT_FOUND',
          ].includes(r.error_code ?? ''),
        )
      )
        old.view = {
          ...old.view,
          status: 'DRAFT',
          user_approval: null,
          invalid_reason: 'PAGE_CHANGED',
        };
      if (done) {
        old.view = {
          ...old.view,
          status: old.view.invalid_reason ? 'DRAFT' : 'REVIEW',
        };
        if (p.action === 'undo')
          old.view = {
            ...old.view,
            status: 'DRAFT',
            user_approval: null,
            invalid_reason: 'USER_UNDONE',
          };
      }
      return save(owner, old, e, body.client_request_id, e, done);
    },
  );
  route(
    '/v1/fill/executions/cancel',
    ExecutionCancelSchema,
    async (
      owner,
      body: {
        task_id: string;
        execution_id: string;
        client_request_id: string;
      },
    ) => {
      const old = record(owner, body.task_id),
        e = find(old, body.execution_id);
      e.cancelled = true;
      return save(owner, old, e, body.client_request_id);
    },
  );
  route(
    '/v1/fill/executions/interrupt',
    ExecutionCancelSchema,
    async (
      owner,
      body: {
        task_id: string;
        execution_id: string;
        client_request_id: string;
      },
    ) => {
      const old = record(owner, body.task_id),
        e = find(old, body.execution_id);
      if (['completed', 'interrupted'].includes(e.phase))
        return save(owner, old, e, body.client_request_id);
      e.cancelled = true;
      e.phase = 'interrupted';
      e.pending_field_id = null;
      e.sequence++;
      e.report.field_results = e.packet.items
        .map((item) => ({
          ...item,
          field_id: item.field.field_id,
          before: item.before,
          target: item.target,
          actual: null,
          status: 'failed' as const,
          error_code: 'EXECUTION_INTERRUPTED',
        }))
        .map(({ field_id, before, target, actual, status, error_code }) => ({
          field_id,
          before,
          target,
          actual,
          status,
          error_code,
        }));
      e.report.ended_at = Date.now();
      old.view = {
        ...old.view,
        status: 'DRAFT',
        user_approval: null,
        invalid_reason: 'EXECUTION_INTERRUPTED',
      };
      return save(owner, old, e, body.client_request_id, e, true);
    },
  );
  route(
    '/v1/fill/verify',
    VerifyRequestSchema,
    async (owner, body: VerifyRequest) => {
      const old = record(owner, body.task_id),
        e = find(old, body.execution_report.execution_id),
        result = verifyExecution(old.view, e, body);
      e.verify_result = result;
      old.view = { ...old.view, status: 'REVIEW' };
      return save(owner, old, e, body.client_request_id, result);
    },
  );
  app.get(
    '/v1/fill/tasks/:task/executions',
    {
      schema: {
        params: Type.Object(
          { task: Type.String({ pattern: '^[a-zA-Z0-9-]{1,64}$' }) },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const session = auth(req, reply);
      if (!session) return;
      const r = store?.get(
        session.workspace_id,
        (req.params as { task: string }).task,
      );
      if (!r)
        return reply
          .status(404)
          .send(
            failure(req.id, 'REFERENCE_NOT_FOUND', '执行任务不存在或已过期'),
          );
      return { request_id: req.id, data: r.executions ?? [], error: null };
    },
  );
}
