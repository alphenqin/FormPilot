import { it, expect, vi } from 'vitest';
import { createApp } from '../../apps/api/src/app';
import { hashJson, type JobParseRequest } from '@formpilot/contracts';
import type { ModelProvider } from '@formpilot/ai';
import { jobSource } from '../fixtures/career';
const token = 'b'.repeat(64);
const output = {
  attributes: [],
  requirements: [
    {
      kind: 'education',
      priority: 'hard',
      quote: '本科及以上学历。',
      term: null,
    },
  ],
};
function provider(generate?: ModelProvider['generate']): ModelProvider {
  return {
    name: 'deepseek',
    model: 'test',
    policyURL: 'https://example.test/policy',
    generate:
      generate ??
      (async () => ({ output, usage: { input_tokens: 1, output_tokens: 1 } })),
  };
}
async function request(): Promise<JobParseRequest> {
  const source = jobSource();
  return {
    schema_version: 1,
    client_request_id: crypto.randomUUID(),
    source,
    consent: {
      granted: true,
      purpose: 'jd_parse',
      provider: 'deepseek',
      model: 'test',
      policy_url: 'https://example.test/policy',
      payload_hash: await hashJson({ source }),
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
  body: JobParseRequest,
) {
  return app.inject({
    method: 'POST',
    url: '/v1/career/jd/parse',
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
    const r = await app.inject({ url: '/v1/career/jd/jobs/' + id, headers });
    if (r.json().data?.status !== 'running') return r;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job timeout');
}
it('并发幂等只调用一次；仅上传 JD 文本，原文锚点仍待确认', async () => {
  const generate = vi.fn(provider().generate),
    app = createApp({ apiToken: token, provider: provider(generate) });
  try {
    const headers = await session(app),
      body = await request();
    const [a, b] = await Promise.all([
      start(app, headers, body),
      start(app, headers, body),
    ]);
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(a.json().data.job_id).toBe(b.json().data.job_id);
    const r = await settled(app, headers, a.json().data.job_id);
    expect(r.json().data.status).toBe('succeeded');
    const requirement = r.json().data.result.requirements[0];
    expect(body.source.text.slice(requirement.start, requirement.end)).toBe(
      requirement.quote,
    );
    expect(requirement.confirmed).toBe(false);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0].input).toEqual({
      text: body.source.text,
    });
    expect(generate.mock.calls[0]![0].operation).toBe('jd_parse');
    body.source.text += 'changed';
    body.consent.payload_hash = await hashJson({ source: body.source });
    expect((await start(app, headers, body)).statusCode).toBe(409);
  } finally {
    await app.close();
  }
});
it('拒绝无授权、错误模型、过期授权、篡改文本与未经脱敏 URL', async () => {
  const generate = vi.fn(provider().generate),
    app = createApp({ apiToken: token, provider: provider(generate) });
  try {
    const headers = await session(app),
      body = await request();
    expect(
      (await start(app, { authorization: 'Bearer wrong' }, body)).statusCode,
    ).toBe(401);
    for (const c of [
      { model: 'wrong' },
      { granted_at: 0 },
      { payload_hash: '0'.repeat(64) },
      { policy_url: 'https://wrong.test' },
    ]) {
      expect(
        (
          await start(app, headers, {
            ...body,
            consent: { ...body.consent, ...c },
          })
        ).statusCode,
      ).toBe(403);
    }
    body.source.page_url = 'https://example.test/job?token=secret';
    body.consent.payload_hash = await hashJson({ source: body.source });
    expect((await start(app, headers, body)).statusCode).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
it('同资料库重新连接可恢复，其他资料库不可读删，撤销会话清理结果', async () => {
  const app = createApp({ apiToken: token, provider: provider() });
  try {
    const workspace = crypto.randomUUID(),
      a = await session(app, workspace),
      b = await session(app),
      reconnect = await session(app, workspace);
    const r = await start(app, a, await request()),
      id = r.json().data.job_id;
    expect((await settled(app, reconnect, id)).json().data.status).toBe(
      'succeeded',
    );
    for (const method of ['GET', 'DELETE'] as const)
      expect(
        (
          await app.inject({
            method,
            url: '/v1/career/jd/jobs/' + id,
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
          url: '/v1/career/jd/jobs/' + id,
          headers: reconnect,
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});
it('拒绝伪造引用和模型输出的总分/个人匹配', async () => {
  for (const bad of [
    { ...output, score: 100 },
    {
      ...output,
      requirements: [{ ...output.requirements[0], quote: '未在原文出现' }],
    },
  ]) {
    const app = createApp({
      apiToken: token,
      provider: provider(async () => ({
        output: bad,
        usage: { input_tokens: 1, output_tokens: 1 },
      })),
    });
    try {
      const h = await session(app),
        r = await start(app, h, await request());
      const done = (await settled(app, h, r.json().data.job_id)).json().data;
      expect(done.status).toBe('failed');
      expect(done.result).toBeNull();
    } finally {
      await app.close();
    }
  }
});
it('超时的迟到结果不能复活；删除任务会中止模型', async () => {
  let release!: () => void;
  let signal!: AbortSignal;
  const app = createApp({
    apiToken: token,
    careerTimeoutMs: 10,
    provider: provider(async (r) => {
      signal = r.signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { output, usage: { input_tokens: 1, output_tokens: 1 } };
    }),
  });
  try {
    const h = await session(app),
      r = await start(app, h, await request()),
      id = r.json().data.job_id;
    expect((await settled(app, h, id)).json().data.error_code).toBe(
      'MODEL_TIMEOUT',
    );
    expect(signal.aborted).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect((await settled(app, h, id)).json().data.result).toBeNull();
    await app.inject({
      method: 'DELETE',
      url: '/v1/career/jd/jobs/' + id,
      headers: h,
    });
    expect((await settled(app, h, id)).statusCode).toBe(404);
  } finally {
    release?.();
    await app.close();
  }
});
