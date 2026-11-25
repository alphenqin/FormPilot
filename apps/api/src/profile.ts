import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  SessionRequestSchema,
  SessionSchema,
  ParseRequestSchema,
  JobSchema,
  envelope,
  failure,
  type ParseRequest,
  type ParseJob,
} from '@formpilot/contracts';
import { parseResume, ModelFault, type ModelProvider } from '@formpilot/ai';
const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex');
interface Session {
  owner: string;
  workspace_id: string;
  expires: number;
}
interface Job {
  owner: string;
  digest: string;
  request_id: string;
  controller: AbortController;
  view: ParseJob;
}
export function registerProfile(
  app: FastifyInstance,
  options: {
    provider?: ModelProvider;
    apiToken?: string;
    parseTimeoutMs?: number;
    jobTtlMs?: number;
  },
) {
  const revokeHooks: ((workspace: string) => void)[] = [];
  const sessions = new Map<string, Session>();
  const jobs = new Map<string, Job>();
  const ttl = options.jobTtlMs ?? 300000;
  const reject = (
    req: FastifyRequest,
    reply: FastifyReply,
    status: number,
    code: Parameters<typeof failure>[1],
    message: string,
  ) => reply.status(status).send(failure(req.id, code, message));
  const auth = (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const session = sessions.get(digest(token));
    if (!session || session.expires < Date.now()) {
      reject(req, reply, 401, 'UNAUTHORIZED', '本地 API 会话无效或过期');
      return null;
    }
    return session;
  };
  const sweep = () => {
    for (const [id, job] of jobs)
      if (job.view.expires_at < Date.now()) {
        job.controller.abort();
        jobs.delete(id);
      }
    for (const [key, session] of sessions)
      if (session.expires < Date.now()) sessions.delete(key);
  };
  const timer = setInterval(sweep, 10000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    for (const job of jobs.values()) job.controller.abort();
    jobs.clear();
    sessions.clear();
  });
  app.post(
    '/v1/sessions',
    {
      schema: {
        body: SessionRequestSchema,
        response: { 201: envelope(SessionSchema) },
      },
    },
    async (req, reply) => {
      if (!options.apiToken || !options.provider)
        return reject(
          req,
          reply,
          503,
          'MODEL_UNAVAILABLE',
          '请在服务端配置模型和本地访问令牌',
        );
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (
        Buffer.byteLength(token) !== Buffer.byteLength(options.apiToken) ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(options.apiToken))
      )
        return reject(req, reply, 401, 'UNAUTHORIZED', '本地访问令牌无效');
      sweep();
      if (sessions.size >= 100)
        return reject(req, reply, 429, 'RATE_LIMITED', '本地会话数量已达上限');
      const value = randomBytes(32).toString('hex');
      const key = digest(value);
      const expires = Date.now() + 30 * 60 * 1000;
      const body = req.body as { workspace_id: string };
      sessions.set(key, {
        owner: key,
        workspace_id: body.workspace_id,
        expires,
      });
      return reply.status(201).send({
        request_id: req.id,
        data: { session_token: value, expires_at: expires },
        error: null,
      });
    },
  );
  app.delete('/v1/sessions/current', async (req, reply) => {
    const session = auth(req, reply);
    if (!session) return;
    for (const [id, job] of jobs)
      if (job.owner === session.owner) {
        job.controller.abort();
        jobs.delete(id);
      }
    for (const hook of revokeHooks) hook(session.workspace_id);
    sessions.delete(session.owner);
    return { request_id: req.id, data: { deleted: true }, error: null };
  });
  app.post(
    '/v1/profile/parse',
    {
      bodyLimit: 614400,
      schema: {
        body: ParseRequestSchema,
        response: { 202: envelope(JobSchema) },
      },
    },
    async (req, reply) => {
      const session = auth(req, reply);
      if (!session) return;
      const provider = options.provider;
      if (!provider)
        return reject(req, reply, 503, 'MODEL_UNAVAILABLE', '模型服务未配置');
      sweep();
      const body = req.body as ParseRequest;
      const consent = body.consent;
      if (
        consent.provider !== provider.name ||
        consent.model !== provider.model ||
        consent.policy_url !== provider.policyURL ||
        Math.abs(Date.now() - consent.granted_at) > 300000 ||
        consent.blocks_hash !== digest(JSON.stringify(body.source_blocks))
      )
        return reject(
          req,
          reply,
          403,
          'CONSENT_REQUIRED',
          '授权范围、模型或文本摘要不一致，请重新确认',
        );
      const blocks = body.source_blocks;
      if (
        blocks.reduce((sum, b) => sum + b.text.length, 0) > 100000 ||
        new Set(blocks.map((b) => b.block_id)).size !== blocks.length ||
        blocks.some(
          (b) =>
            b.document_id !== body.document_id ||
            b.document_revision !== body.document_revision ||
            b.end - b.start !== b.text.length,
        )
      )
        return reject(
          req,
          reply,
          400,
          'INVALID_REQUEST',
          '文档分块引用或文本大小无效',
        );
      const contentHash = digest(
        JSON.stringify({
          document_id: body.document_id,
          document_revision: body.document_revision,
          source_blocks: body.source_blocks,
          consent: { ...consent, granted_at: 0 },
        }),
      );
      for (const job of jobs.values())
        if (
          job.owner === session.owner &&
          job.request_id === body.client_request_id
        ) {
          if (job.digest !== contentHash)
            return reject(
              req,
              reply,
              409,
              'IDEMPOTENCY_CONFLICT',
              '相同请求 ID 不能对应不同文本',
            );
          return reply
            .status(202)
            .send({ request_id: req.id, data: job.view, error: null });
        }
      if (
        jobs.size >= 20 ||
        [...jobs.values()].filter(
          (j) => j.owner === session.owner && j.view.status === 'running',
        ).length >= 2
      )
        return reject(
          req,
          reply,
          429,
          'RATE_LIMITED',
          '解析任务已达上限，请稍后再试',
        );
      const job_id = randomBytes(16).toString('hex');
      const controller = new AbortController();
      const job: Job = {
        owner: session.owner,
        digest: contentHash,
        request_id: body.client_request_id,
        controller,
        view: {
          job_id,
          status: 'running',
          result: null,
          error_code: null,
          expires_at: Date.now() + ttl,
        },
      };
      jobs.set(job_id, job);
      const timeout = setTimeout(() => {
        controller.abort();
        if (jobs.get(job_id) === job) {
          job.view.status = 'failed';
          job.view.error_code = 'MODEL_TIMEOUT';
        }
      }, options.parseTimeoutMs ?? 60000);
      timeout.unref();
      void parseResume(provider, body, controller.signal)
        .then((result) => {
          if (jobs.get(job_id) === job && !controller.signal.aborted) {
            job.view.status = 'succeeded';
            job.view.result = result;
          }
        })
        .catch((error) => {
          if (jobs.get(job_id) === job) {
            job.view.status = 'failed';
            job.view.error_code = controller.signal.aborted
              ? 'MODEL_TIMEOUT'
              : error instanceof ModelFault
                ? error.code
                : 'MODEL_INVALID_OUTPUT';
          }
        })
        .finally(() => clearTimeout(timeout));
      return reply
        .status(202)
        .send({ request_id: req.id, data: job.view, error: null });
    },
  );
  const params = Type.Object(
    { job_id: Type.String({ pattern: '^[a-f0-9]{32}$' }) },
    { additionalProperties: false },
  );
  app.get(
    '/v1/profile/parse/jobs/:job_id',
    { schema: { params, response: { 200: envelope(JobSchema) } } },
    async (req, reply) => {
      const session = auth(req, reply);
      if (!session) return;
      sweep();
      const job = jobs.get((req.params as { job_id: string }).job_id);
      if (!job || job.owner !== session.owner)
        return reject(
          req,
          reply,
          404,
          'REFERENCE_NOT_FOUND',
          '任务不存在、已过期或服务已重启',
        );
      return { request_id: req.id, data: job.view, error: null };
    },
  );
  app.delete(
    '/v1/profile/parse/jobs/:job_id',
    { schema: { params } },
    async (req, reply) => {
      const session = auth(req, reply);
      if (!session) return;
      const id = (req.params as { job_id: string }).job_id;
      const job = jobs.get(id);
      if (!job || job.owner !== session.owner)
        return reject(
          req,
          reply,
          404,
          'REFERENCE_NOT_FOUND',
          '任务不存在或已过期',
        );
      job.controller.abort();
      jobs.delete(id);
      return { request_id: req.id, data: { deleted: true }, error: null };
    },
  );
  return {
    auth,
    onRevoke: (hook: (workspace: string) => void) => {
      revokeHooks.push(hook);
    },
  };
}
