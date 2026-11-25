import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  Id,
  AnswerRequestSchema,
  AnswerResultSchema,
  hashJson,
  failure,
  type AnswerRequest,
  type AnswerTask,
  type ErrorCode,
} from '@formpilot/contracts';
import { validateAnswerInput, PlanningFault } from '@formpilot/domain';
import {
  generateOpenAnswer,
  ModelFault,
  type ModelProvider,
} from '@formpilot/ai';
type Auth = (
  req: FastifyRequest,
  reply: FastifyReply,
) => { workspace_id: string } | null;
interface Task {
  workspace: string;
  hash: string;
  client_request_id: string;
  controller: AbortController;
  view: AnswerTask;
  timer: ReturnType<typeof setTimeout>;
}
export function registerAnswers(
  app: FastifyInstance,
  auth: Auth,
  provider?: ModelProvider,
  timeoutMs = 60000,
  ttl = 300000,
) {
  const jobs = new Map<string, Task>();
  const generations = new Map<string, number>();
  const clear = (id: string, t: Task) => {
    t.controller.abort();
    clearTimeout(t.timer);
    jobs.delete(id);
  };
  const sweep = () => {
    for (const [id, t] of jobs)
      if (t.view.expires_at < Date.now()) clear(id, t);
  };
  const timer = setInterval(sweep, 10000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    for (const [id, t] of jobs) clear(id, t);
  });
  const reject = (
    req: FastifyRequest,
    reply: FastifyReply,
    status: number,
    code: ErrorCode,
  ) =>
    reply
      .status(status)
      .send(failure(req.id, code, '开放题生成未完成：' + code));
  app.post(
    '/v1/career/answers/generate',
    { bodyLimit: 524288, schema: { body: AnswerRequestSchema } },
    async (req, reply) => {
      const session = auth(req, reply);
      if (!session) return;
      if (!provider) return reject(req, reply, 503, 'MODEL_UNAVAILABLE');
      const generation = generations.get(session.workspace_id) ?? 0;
      const body = req.body as AnswerRequest;
      try {
        validateAnswerInput(body.input);
      } catch {
        return reject(req, reply, 400, 'INVALID_REQUEST');
      }
      const c = body.consent;
      if (req.headers['idempotency-key'] !== body.client_request_id)
        return reject(req, reply, 400, 'INVALID_REQUEST');
      if (
        c.provider !== provider.name ||
        c.model !== provider.model ||
        c.policy_url !== provider.policyURL ||
        Math.abs(Date.now() - c.granted_at) > 300000 ||
        c.payload_hash !== (await hashJson(body.input))
      )
        return reject(req, reply, 403, 'CONSENT_REQUIRED');
      const hash = await hashJson({
        input: body.input,
        consent: { ...c, granted_at: 0 },
      });
      if (generation !== (generations.get(session.workspace_id) ?? 0))
        return reject(req, reply, 401, 'UNAUTHORIZED');
      sweep();
      for (const t of jobs.values())
        if (
          t.workspace === session.workspace_id &&
          t.client_request_id === body.client_request_id
        ) {
          if (t.hash !== hash)
            return reject(req, reply, 409, 'IDEMPOTENCY_CONFLICT');
          return reply
            .status(202)
            .send({ request_id: req.id, data: t.view, error: null });
        }
      if (
        jobs.size >= 20 ||
        [...jobs.values()].filter(
          (t) =>
            t.workspace === session.workspace_id && t.view.status === 'running',
        ).length >= 2
      )
        return reject(req, reply, 429, 'RATE_LIMITED');
      const id = randomBytes(16).toString('hex'),
        controller = new AbortController();
      const task: Task = {
        workspace: session.workspace_id,
        hash,
        client_request_id: body.client_request_id,
        controller,
        view: {
          job_id: id,
          status: 'running',
          result: null,
          error_code: null,
          expires_at: Date.now() + ttl,
        },
        timer: setTimeout(() => {
          controller.abort();
          if (jobs.get(id) === task) {
            task.view.status = 'failed';
            task.view.error_code = 'MODEL_TIMEOUT';
          }
        }, timeoutMs),
      };
      task.timer.unref();
      jobs.set(id, task);
      void generateOpenAnswer(provider, body.input, controller.signal)
        .then((result) => {
          if (!Value.Check(AnswerResultSchema, result))
            throw new ModelFault('MODEL_INVALID_OUTPUT');
          if (jobs.get(id) === task && !controller.signal.aborted) {
            task.view.status = 'succeeded';
            task.view.result = result;
          }
        })
        .catch((error) => {
          if (jobs.get(id) === task) {
            task.view.status = 'failed';
            task.view.error_code = controller.signal.aborted
              ? 'MODEL_TIMEOUT'
              : error instanceof ModelFault || error instanceof PlanningFault
                ? error.code
                : 'MODEL_INVALID_OUTPUT';
          }
        })
        .finally(() => clearTimeout(task.timer));
      return reply
        .status(202)
        .send({ request_id: req.id, data: task.view, error: null });
    },
  );
  const params = Type.Object(
    { id: Type.String({ pattern: '^[a-f0-9]{32}$' }) },
    { additionalProperties: false },
  );
  app.get(
    '/v1/career/answers/jobs/:id',
    { schema: { params } },
    async (req, reply) => {
      const session = auth(req, reply);
      if (!session) return;
      sweep();
      const t = jobs.get((req.params as { id: string }).id);
      if (!t || t.workspace !== session.workspace_id)
        return reject(req, reply, 404, 'REFERENCE_NOT_FOUND');
      return { request_id: req.id, data: t.view, error: null };
    },
  );
  app.get(
    '/v1/career/answers/requests/:id',
    {
      schema: {
        params: Type.Object({ id: Id }, { additionalProperties: false }),
      },
    },
    async (req, reply) => {
      const session = auth(req, reply);
      if (!session) return;
      sweep();
      const task = [...jobs.values()].find(
        (t) =>
          t.workspace === session.workspace_id &&
          t.client_request_id === (req.params as { id: string }).id,
      );
      if (!task) return reject(req, reply, 404, 'REFERENCE_NOT_FOUND');
      return { request_id: req.id, data: task.view, error: null };
    },
  );
  app.delete(
    '/v1/career/answers/jobs/:id',
    { schema: { params } },
    async (req, reply) => {
      const session = auth(req, reply);
      if (!session) return;
      const id = (req.params as { id: string }).id,
        t = jobs.get(id);
      if (!t || t.workspace !== session.workspace_id)
        return reject(req, reply, 404, 'REFERENCE_NOT_FOUND');
      clear(id, t);
      return { request_id: req.id, data: { deleted: true }, error: null };
    },
  );
  return {
    revoke(workspace: string) {
      generations.set(workspace, (generations.get(workspace) ?? 0) + 1);
      for (const [id, t] of jobs) if (t.workspace === workspace) clear(id, t);
    },
  };
}
