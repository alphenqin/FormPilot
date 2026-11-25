import { registerAnswers } from './answers';
import { registerCareer } from './career';
import { registerExecution } from './execution';
import { randomBytes } from 'node:crypto';
import { PlanStore } from './plan-store';
import { registerPlanning } from './planning';
import { registerProfile } from './profile';
import type { ModelProvider } from '@formpilot/ai';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  HealthEnvelopeSchema,
  CapabilitiesEnvelopeSchema,
  FailureEnvelopeSchema,
  failure,
} from '@formpilot/contracts';
import { logRecord } from '@formpilot/config';
export function createApp(
  options: {
    logging?: boolean;
    planStore?: PlanStore | null;
    planTimeoutMs?: number;
    provider?: ModelProvider;
    apiToken?: string;
    parseTimeoutMs?: number;
    jobTtlMs?: number;
    careerTimeoutMs?: number;
    careerTtlMs?: number;
    answerTimeoutMs?: number;
    answerTtlMs?: number;
    logSink?: (record: Record<string, unknown>) => void;
  } = {},
) {
  const store =
    options.planStore === undefined
      ? new PlanStore(randomBytes(32))
      : options.planStore;
  const app = Fastify({
    logger: false,
    bodyLimit: 16384,
    genReqId: () => randomUUID(),
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
        useDefaults: false,
      },
    },
  });
  app.addHook('onResponse', async (req, reply) => {
    const record = logRecord({
      event: 'http_request',
      request_id: req.id,
      status_code: reply.statusCode,
      duration_ms: reply.elapsedTime,
    });
    if (options.logSink) options.logSink(record);
    else if (options.logging)
      process.stdout.write(JSON.stringify(record) + '\n');
  });
  app.setErrorHandler((error, req, reply) => {
    const e = error as { statusCode?: number; validation?: unknown };
    const status =
      e.statusCode === 413
        ? 413
        : e.statusCode && e.statusCode < 500
          ? 400
          : 500;
    reply
      .status(status)
      .send(
        failure(
          req.id,
          status === 413
            ? 'PAYLOAD_TOO_LARGE'
            : status === 400
              ? 'INVALID_REQUEST'
              : 'INTERNAL_ERROR',
          status === 500 ? '服务暂时不可用' : '请求无效',
          status === 500,
        ),
      );
  });
  app.setNotFoundHandler((req, reply) =>
    reply
      .status(404)
      .send(failure(req.id, 'REFERENCE_NOT_FOUND', '接口不存在或尚未实现')),
  );
  app.get(
    '/health',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        response: { 200: HealthEnvelopeSchema, 400: FailureEnvelopeSchema },
      },
    },
    async (req) => ({
      request_id: req.id,
      data: { status: 'ok', service: 'formpilot-api', protocol_version: '1' },
      error: null,
    }),
  );
  app.get(
    '/v1/system/capabilities',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        response: {
          200: CapabilitiesEnvelopeSchema,
          400: FailureEnvelopeSchema,
        },
      },
    },
    async (req) => ({
      request_id: req.id,
      data: {
        stage: 'M5.3',
        career_available: !!(options.provider && options.apiToken),
        execution_available: !!(store && options.apiToken && options.provider),
        planning_available: !!(store && options.provider && options.apiToken),
        model_available: !!(options.provider && options.apiToken),
        operations:
          options.provider && options.apiToken
            ? store
              ? [
                  'health',
                  'profile_parse',
                  'fill_plan',
                  'resolve',
                  'fill_execute',
                  'fill_verify',
                  'jd_parse',
                  'job_match_local',
                  'resume_tailor_local',
                  'answer_generate',
                ]
              : [
                  'health',
                  'profile_parse',
                  'jd_parse',
                  'job_match_local',
                  'resume_tailor_local',
                  'answer_generate',
                ]
            : ['health'],
        provider: options.provider?.name ?? '',
        model: options.provider?.model ?? '',
        policy_url: options.provider?.policyURL ?? '',
      },
      error: null,
    }),
  );
  const profile = registerProfile(app, options);
  const planning = registerPlanning(
    app,
    profile.auth,
    store,
    options.provider,
    options.planTimeoutMs,
  );
  profile.onRevoke(planning.revoke);
  registerExecution(app, profile.auth, store);
  const career = registerCareer(
    app,
    profile.auth,
    options.provider,
    options.careerTimeoutMs,
    options.careerTtlMs,
  );
  profile.onRevoke(career.revoke);
  const answers = registerAnswers(
    app,
    profile.auth,
    options.provider,
    options.answerTimeoutMs,
    options.answerTtlMs,
  );
  profile.onRevoke(answers.revoke);
  return app;
}
