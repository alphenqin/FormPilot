import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  FillPlanRequestSchema,
  ResolveRequestSchema,
  ApproveRequestSchema,
  InvalidateRequestSchema,
  FillPlanViewSchema,
  canonicalJson,
  hashJson,
  planConsentPayload,
  failure,
  envelope,
  FailureEnvelopeSchema,
  type ErrorCode,
  type FillPlanRequest,
  type ResolveRequest,
  type ApproveRequest,
  type FillPlanView,
} from '@formpilot/contracts';
import {
  buildFillPlan,
  newPlanningContext,
  validatePlanningInput,
  validateModelMappings,
  resolveContext,
  PlanningFault,
} from '@formpilot/domain';
import { ModelFault, type ModelProvider } from '@formpilot/ai';
import { PlanStore, type StoredPlan } from './plan-store';
type Auth = (
  req: FastifyRequest,
  reply: FastifyReply,
) => { workspace_id: string } | null;
const fault = (code: ErrorCode): never => {
  throw new PlanningFault(code);
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const status = (view: FillPlanView) =>
  view.field_decisions.some(
    (d) => d.decision === 'ask' || d.decision === 'review',
  )
    ? ('WAITING_USER' as const)
    : ('PLANNED' as const);
export function registerPlanning(
  app: FastifyInstance,
  auth: Auth,
  store: PlanStore | null,
  provider?: ModelProvider,
  timeoutMs = 25000,
) {
  const pending = new Map<
    string,
    { hash: string; work: Promise<FillPlanView> }
  >();
  const controllers = new Set<AbortController>();
  const sweepTimer = setInterval(() => store?.sweep(), 60000);
  sweepTimer.unref();
  const generations = new Map<string, number>();
  app.addHook('onClose', async () => {
    clearInterval(sweepTimer);
    for (const c of controllers) c.abort();
    store?.close();
  });
  const revoke = (owner: string) => {
    generations.set(owner, (generations.get(owner) ?? 0) + 1);
    store?.forget(owner);
  };
  function current(
    owner: string,
    body: { task_id: string; plan_id: string; expected_plan_revision: number },
  ) {
    const record = store!.get(owner, body.task_id);
    if (!record) return fault('REFERENCE_NOT_FOUND');
    if (
      record.view.plan_id !== body.plan_id ||
      record.view.plan_revision !== body.expected_plan_revision
    )
      return fault('REVISION_CONFLICT');
    if (record.view.invalid_reason) return fault('STALE_PLAN');
    return record;
  }
  function route(
    path: string,
    schema: TSchema,
    operation: (owner: string, body: never) => Promise<FillPlanView>,
  ) {
    app.post(
      path,
      {
        bodyLimit: 1000000,
        schema: {
          body: schema,
          response: {
            200: envelope(FillPlanViewSchema),
            400: FailureEnvelopeSchema,
            401: FailureEnvelopeSchema,
            403: FailureEnvelopeSchema,
            404: FailureEnvelopeSchema,
            409: FailureEnvelopeSchema,
            500: FailureEnvelopeSchema,
            503: FailureEnvelopeSchema,
          },
        },
      },
      async (req, reply) => {
        const session = auth(req, reply);
        if (!session) return;
        if (!store)
          return reply
            .status(503)
            .send(failure(req.id, 'STORAGE_UNAVAILABLE', '计划加密存储未配置'));
        const body = req.body as { client_request_id: string };
        try {
          if (req.headers['idempotency-key'] !== body.client_request_id)
            fault('INVALID_REQUEST');
          const owner = session.workspace_id,
            key = owner + ':' + body.client_request_id;
          const generation = generations.get(owner) ?? 0;
          const hash = await hashJson({ path, body });
          if (generation !== (generations.get(owner) ?? 0))
            fault('UNAUTHORIZED');
          const active = pending.get(key);
          if (active && active.hash !== hash) fault('IDEMPOTENCY_CONFLICT');
          let view: FillPlanView;
          if (active) view = await active.work;
          else {
            const replay = store.reserve(owner, body.client_request_id, hash);
            if (replay) {
              const latest = store.get(owner, replay.task_id)?.view;
              // A historical idempotent approval must never resurrect a revoked approval.
              view =
                latest && latest.state_revision !== replay.state_revision
                  ? latest
                  : replay;
            } else {
              const work = operation(owner, body as never);
              pending.set(key, { hash, work });
              try {
                view = await work;
              } finally {
                pending.delete(key);
              }
            }
          }
          return { request_id: req.id, data: view, error: null };
        } catch (error) {
          const known = [
            'IDEMPOTENCY_CONFLICT',
            'TASK_INTERRUPTED',
            'REVISION_CONFLICT',
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
                  : code === 'SCOPE_DENIED'
                    ? 403
                    : code === 'CONSENT_REQUIRED'
                      ? 400
                      : 409,
            )
            .send(failure(req.id, code, '计划操作未完成：' + code));
        }
      },
    );
  }
  async function save(
    owner: string,
    old: StoredPlan | null,
    record: StoredPlan,
    operation: string,
  ) {
    if (!Value.Check(FillPlanViewSchema, record.view)) fault('RULE_VIOLATION');
    store!.put(
      owner,
      record.view.task_id,
      old?.view.state_revision ?? 0,
      record,
      operation,
    );
    return record.view;
  }
  route(
    '/v1/fill/plan',
    FillPlanRequestSchema,
    async (owner, body: FillPlanRequest) => {
      if (!provider) return fault('MODEL_UNAVAILABLE');
      validatePlanningInput(body);
      const prior = store!.get(owner, body.task_id);
      if (prior?.view.status === 'WRITING') return fault('EXECUTION_LOCKED');
      if ((prior?.view.plan_revision ?? 0) !== body.expected_plan_revision)
        return fault('REVISION_CONFLICT');
      if (
        body.task_answers.length &&
        !same(body.task_answers, prior?.view.task_answers ?? [])
      )
        return fault('SCOPE_DENIED');
      if (
        Date.now() - body.form_snapshot.captured_at > 900000 ||
        body.form_snapshot.captured_at > Date.now() + 5000
      )
        return fault('STALE_SNAPSHOT');
      const c = body.consent;
      if (
        c.provider !== provider.name ||
        c.model !== provider.model ||
        c.policy_url !== provider.policyURL ||
        Math.abs(Date.now() - c.granted_at) > 300000 ||
        c.payload_hash !== (await hashJson(planConsentPayload(body)))
      )
        return fault('CONSENT_REQUIRED');
      const ctx = newPlanningContext(body, { mappings: [] }),
        start = performance.now(),
        generation = generations.get(owner) ?? 0;
      let usage = { input_tokens: 0, output_tokens: 0 };
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await Promise.race([
          provider.generate({
            operation: 'plan',
            input: {
              fields: body.form_snapshot.fields,
              groups: body.form_snapshot.groups,
              entities: body.entities,
            },
            signal: controller.signal,
          }),
          new Promise<never>((_, reject) =>
            controller.signal.addEventListener(
              'abort',
              () => reject(new ModelFault('MODEL_TIMEOUT')),
              { once: true },
            ),
          ),
        ]);
        ctx.mappings = validateModelMappings(body, response.output);
        usage = response.usage;
      } catch (error) {
        ctx.model_error =
          error instanceof ModelFault || error instanceof PlanningFault
            ? error.code
            : 'MODEL_UNAVAILABLE';
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
      }
      if (generation !== (generations.get(owner) ?? 0))
        return fault('UNAUTHORIZED');
      const core = await buildFillPlan(ctx, {
        plan_id: randomUUID(),
        plan_revision: body.expected_plan_revision + 1,
        expires_at: Date.now() + 86400000,
        usage,
        duration_ms: performance.now() - start,
      });
      if (generation !== (generations.get(owner) ?? 0))
        return fault('UNAUTHORIZED');
      const view: FillPlanView = {
        ...core,
        status: 'PLANNED',
        state_revision: (prior?.view.state_revision ?? 0) + 1,
        user_approval: null,
        invalid_reason: null,
      };
      view.status = status(view);
      return save(
        owner,
        prior,
        {
          executions: prior?.executions ?? [],
          execution_epoch: prior?.execution_epoch ?? 0,
          context: ctx,
          view,
          history: prior ? [...prior.history, prior.view].slice(-40) : [],
        },
        body.client_request_id,
      );
    },
  );
  route(
    '/v1/fill/resolve',
    ResolveRequestSchema,
    async (owner, body: ResolveRequest) => {
      const old = current(owner, body),
        context =
          old.view.status === 'WRITING'
            ? fault('EXECUTION_LOCKED')
            : resolveContext(old.context, old.view, body);
      const core = await buildFillPlan(context, {
        plan_id: randomUUID(),
        plan_revision: old.view.plan_revision + 1,
        expires_at: old.view.expires_at,
        usage: { input_tokens: 0, output_tokens: 0 },
        duration_ms: 0,
      });
      const view: FillPlanView = {
        ...core,
        status: 'PLANNED',
        state_revision: old.view.state_revision + 1,
        user_approval: null,
        invalid_reason: null,
      };
      view.status = status(view);
      return save(
        owner,
        old,
        {
          ...old,
          context,
          view,
          history: [...old.history, old.view].slice(-40),
        },
        body.client_request_id,
      );
    },
  );
  route(
    '/v1/fill/approve',
    ApproveRequestSchema,
    async (owner, body: ApproveRequest) => {
      const old = current(owner, body),
        v = old.view;
      if (
        v.status === 'READY' ||
        v.status === 'WRITING' ||
        v.status === 'DRAFT' ||
        body.plan_digest !== v.plan_digest ||
        body.observed_profile_revision !== v.profile_revision ||
        !same(body.observed_snapshot_ref, v.snapshot_ref) ||
        Math.abs(Date.now() - body.observed_at) > 10000
      )
        return fault('STALE_PLAN');
      if (
        new Set(body.approved_field_ids).size !==
          body.approved_field_ids.length ||
        body.approved_field_ids.some(
          (id) =>
            !v.field_decisions.some(
              (d) => d.field_id === id && d.decision === 'fill',
            ),
        ) ||
        v.field_decisions.some((d) => d.decision === 'review')
      )
        return fault('RULE_VIOLATION');
      const view: FillPlanView = {
        ...v,
        status: 'READY',
        state_revision: v.state_revision + 1,
        user_approval: {
          approval_id: randomUUID(),
          plan_id: v.plan_id,
          plan_revision: v.plan_revision,
          plan_digest: v.plan_digest,
          task_id: v.task_id,
          profile_revision: v.profile_revision,
          snapshot_ref: v.snapshot_ref,
          approved_field_ids: body.approved_field_ids,
          approved_at: Date.now(),
        },
      };
      return save(owner, old, { ...old, view }, body.client_request_id);
    },
  );
  route(
    '/v1/fill/invalidate',
    InvalidateRequestSchema,
    async (
      owner,
      body: {
        task_id: string;
        plan_id: string;
        expected_plan_revision: number;
        reason: string;
        client_request_id: string;
      },
    ) => {
      const old = store!.get(owner, body.task_id);
      if (!old) return fault('REFERENCE_NOT_FOUND');
      if (
        old.view.plan_id !== body.plan_id ||
        old.view.plan_revision !== body.expected_plan_revision
      )
        return fault('REVISION_CONFLICT');
      return save(
        owner,
        old,
        {
          ...old,
          view: {
            ...old.view,
            status: 'DRAFT',
            state_revision: old.view.state_revision + 1,
            user_approval: null,
            invalid_reason: body.reason,
          },
        },
        body.client_request_id,
      );
    },
  );
  app.get(
    '/v1/fill/tasks/:task',
    {
      schema: {
        params: Type.Object(
          { task: Type.String({ pattern: '^[a-zA-Z0-9-]{1,64}$' }) },
          { additionalProperties: false },
        ),
        response: {
          200: envelope(FillPlanViewSchema),
          400: FailureEnvelopeSchema,
          401: FailureEnvelopeSchema,
          403: FailureEnvelopeSchema,
          404: FailureEnvelopeSchema,
          409: FailureEnvelopeSchema,
          500: FailureEnvelopeSchema,
          503: FailureEnvelopeSchema,
        },
      },
    },
    async (req, reply) => {
      const session = auth(req, reply);
      if (!session) return;
      const record = store?.get(
        session.workspace_id,
        (req.params as { task: string }).task,
      );
      if (!record)
        return reply
          .status(404)
          .send(failure(req.id, 'REFERENCE_NOT_FOUND', '计划不存在或已过期'));
      return { request_id: req.id, data: record.view, error: null };
    },
  );
  return { revoke };
}
