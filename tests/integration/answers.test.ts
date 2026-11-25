import { it, expect, vi } from 'vitest';
import { createApp } from '../../apps/api/src/app';
import {
  hashJson,
  type AnswerRequest,
  type AnswerInput,
} from '@formpilot/contracts';
import type { ModelProvider } from '@formpilot/ai';
import { answerFixture, answerSelection } from '../fixtures/answer';
const token = 'b'.repeat(64);
function provider(generate?: ModelProvider['generate']): ModelProvider {
  return {
    name: 'deepseek',
    model: 'test',
    policyURL: 'https://example.test/policy',
    generate:
      generate ??
      (async ({ input }) => ({
        output: answerSelection(input as AnswerInput),
        usage: { input_tokens: 1, output_tokens: 1 },
      })),
  };
}
async function request(): Promise<AnswerRequest> {
  const f = await answerFixture();
  return {
    schema_version: 1,
    client_request_id: crypto.randomUUID(),
    input: f.input,
    consent: {
      granted: true,
      purpose: 'answer_generate',
      provider: 'deepseek',
      model: 'test',
      policy_url: 'https://example.test/policy',
      payload_hash: await hashJson(f.input),
      granted_at: Date.now(),
    },
  };
}
async function session(
  app: ReturnType<typeof createApp>,
  workspace_id = crypto.randomUUID(),
) {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: { authorization: 'Bearer ' + token },
    payload: { workspace_id },
  });
  expect(r.statusCode).toBe(201);
  return { authorization: 'Bearer ' + r.json().data.session_token };
}
function start(
  app: ReturnType<typeof createApp>,
  headers: { authorization: string },
  body: AnswerRequest,
) {
  return app.inject({
    method: 'POST',
    url: '/v1/career/answers/generate',
    headers: { ...headers, 'idempotency-key': body.client_request_id },
    payload: body,
  });
}
async function settled(
  app: ReturnType<typeof createApp>,
  headers: { authorization: string },
  id: string,
) {
  for (let i = 0; i < 100; i++) {
    const r = await app.inject({
      url: '/v1/career/answers/jobs/' + id,
      headers,
    });
    if (r.json().data?.status !== 'running') return r;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timeout');
}

it('并发幂等只生成一次；上游仅收到已授权输入，结果没有批准或虚构改写', async () => {
  const generate = vi.fn(provider().generate),
    app = createApp({ apiToken: token, provider: provider(generate) });
  try {
    const h = await session(app),
      body = await request();
    const [a, b] = await Promise.all([
      start(app, h, body),
      start(app, h, body),
    ]);
    expect(a.statusCode).toBe(202);
    expect(a.json().data.job_id).toBe(b.json().data.job_id);
    const done = (await settled(app, h, a.json().data.job_id)).json().data;
    expect(done.status).toBe('succeeded');
    expect(done.result.generated_text).toContain('未负责数据库优化');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0].operation).toBe('answer_generate');
    expect(generate.mock.calls[0]![0].input).toEqual(body.input);
    expect(JSON.stringify(generate.mock.calls)).not.toContain(
      'PRIVATE_NAME_NOT_SENT',
    );
    expect(JSON.stringify(generate.mock.calls)).not.toContain('evidences');
    body.input.question += ' changed';
    body.consent.payload_hash = await hashJson(body.input);
    expect((await start(app, h, body)).statusCode).toBe(409);
  } finally {
    await app.close();
  }
});
it('无授权、错误摘要/模型/时效、未知字段和禁止发送的事实被拒绝', async () => {
  const generate = vi.fn(provider().generate),
    app = createApp({ apiToken: token, provider: provider(generate) });
  try {
    const h = await session(app),
      body = await request();
    expect(
      (await start(app, { authorization: 'Bearer invalid' }, body)).statusCode,
    ).toBe(401);
    for (const bad of [
      { payload_hash: '0'.repeat(64) },
      { model: 'wrong' },
      { granted_at: 0 },
      { policy_url: 'https://wrong.test' },
    ])
      expect(
        (await start(app, h, { ...body, consent: { ...body.consent, ...bad } }))
          .statusCode,
      ).toBe(403);
    expect(
      (await start(app, h, { ...body, score: 100 } as AnswerRequest))
        .statusCode,
    ).toBe(400);
    const forbidden = structuredClone(body);
    forbidden.input.facts[0]!.path = 'basic.phone';
    forbidden.consent.payload_hash = await hashJson(forbidden.input);
    expect((await start(app, h, forbidden)).statusCode).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
it('未知引用、删除否定词、额外总分、空引用与模型异常不产生答案', async () => {
  for (const mode of ['id', 'negation', 'score', 'empty', 'error']) {
    const app = createApp({
      apiToken: token,
      provider: provider(async ({ input }) => {
        const output = answerSelection(input as AnswerInput);
        if (mode === 'error') throw new Error('PRIVATE_PROVIDER_ERROR');
        if (mode === 'id') output.citations[0]!.fact_id = 'unknown';
        if (mode === 'negation')
          output.citations.at(-1)!.quote = output.citations
            .at(-1)!
            .quote.replace('未负责', '负责');
        if (mode === 'empty') output.citations = [];
        return {
          output: mode === 'score' ? { ...output, score: 100 } : output,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }),
    });
    try {
      const h = await session(app),
        r = await start(app, h, await request());
      const result = (await settled(app, h, r.json().data.job_id)).json().data;
      expect(result.status).toBe('failed');
      expect(result.result).toBeNull();
      expect(JSON.stringify(result)).not.toContain('PRIVATE_PROVIDER_ERROR');
    } finally {
      await app.close();
    }
  }
});
it('丢失启动响应时只读恢复不付费；工作空间隔离与撤销清理', async () => {
  const generate = vi.fn(provider().generate),
    app = createApp({ apiToken: token, provider: provider(generate) });
  try {
    const workspace = crypto.randomUUID(),
      a = await session(app, workspace),
      reconnect = await session(app, workspace),
      b = await session(app),
      body = await request();
    const r = await start(app, a, body),
      id = r.json().data.job_id;
    for (const headers of [a, reconnect])
      expect(
        (
          await app.inject({
            url: '/v1/career/answers/requests/' + body.client_request_id,
            headers,
          })
        ).json().data.job_id,
      ).toBe(id);
    for (const method of ['GET', 'DELETE'] as const)
      expect(
        (
          await app.inject({
            method,
            url: '/v1/career/answers/jobs/' + id,
            headers: b,
          })
        ).statusCode,
      ).toBe(404);
    expect(
      (
        await app.inject({
          url: '/v1/career/answers/requests/' + body.client_request_id,
          headers: b,
        })
      ).statusCode,
    ).toBe(404);
    await app.inject({
      method: 'DELETE',
      url: '/v1/sessions/current',
      headers: a,
    });
    expect(
      (
        await app.inject({
          url: '/v1/career/answers/requests/' + body.client_request_id,
          headers: reconnect,
        })
      ).statusCode,
    ).toBe(404);
    expect(generate).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
it('超时及取消后的迟到结果不能复活，取消请求会中止模型', async () => {
  const pending: { resolve: () => void; signal: AbortSignal }[] = [];
  const app = createApp({
    apiToken: token,
    answerTimeoutMs: 15,
    provider: provider(async ({ input, signal }) => {
      await new Promise<void>((resolve) => pending.push({ resolve, signal }));
      return {
        output: answerSelection(input as AnswerInput),
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }),
  });
  try {
    const h = await session(app),
      first = await start(app, h, await request()),
      id = first.json().data.job_id;
    expect((await settled(app, h, id)).json().data.error_code).toBe(
      'MODEL_TIMEOUT',
    );
    expect(pending[0]!.signal.aborted).toBe(true);
    pending[0]!.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect((await settled(app, h, id)).json().data.result).toBeNull();
    const second = await start(app, h, await request()),
      next = second.json().data.job_id;
    await app.inject({
      method: 'DELETE',
      url: '/v1/career/answers/jobs/' + next,
      headers: h,
    });
    expect(pending[1]!.signal.aborted).toBe(true);
    pending[1]!.resolve();
    expect((await settled(app, h, next)).statusCode).toBe(404);
  } finally {
    pending.forEach((p) => p.resolve());
    await app.close();
  }
});
it('结果过期和日志白名单；只读查询过期任务不会启动新调用', async () => {
  const logs: unknown[] = [],
    generate = vi.fn(provider().generate),
    app = createApp({
      apiToken: token,
      provider: provider(generate),
      answerTtlMs: 30,
      logSink: (r) => logs.push(r),
    });
  try {
    const h = await session(app),
      body = await request();
    body.input.question = 'PRIVATE_QUESTION_SENTINEL';
    body.consent.payload_hash = await hashJson(body.input);
    const r = await start(app, h, body);
    await settled(app, h, r.json().data.job_id);
    await new Promise((r) => setTimeout(r, 35));
    expect(
      (
        await app.inject({
          url: '/v1/career/answers/requests/' + body.client_request_id,
          headers: h,
        })
      ).statusCode,
    ).toBe(404);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logs)).not.toContain('PRIVATE_QUESTION_SENTINEL');
    expect(JSON.stringify(logs)).not.toContain(token);
  } finally {
    await app.close();
  }
});
