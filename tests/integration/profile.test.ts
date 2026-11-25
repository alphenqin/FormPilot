import { it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createApp } from '../../apps/api/src/app';
import { ModelFault, type ModelProvider } from '@formpilot/ai';
import {
  syntheticDocument,
  nameExtraction,
} from '../fixtures/resumes/synthetic';
const token = 'b'.repeat(64);
function request() {
  const d = syntheticDocument();
  return {
    client_request_id: crypto.randomUUID(),
    document_id: d.document_id,
    document_revision: 1 as const,
    source_blocks: d.blocks,
    consent: {
      granted: true as const,
      purpose: 'resume_parse' as const,
      provider: 'deepseek',
      model: 'test-model',
      policy_url: 'https://example.test/policy',
      granted_at: Date.now(),
      blocks_hash: createHash('sha256')
        .update(JSON.stringify(d.blocks))
        .digest('hex'),
    },
  };
}
function provider(generate?: ModelProvider['generate']): ModelProvider {
  return {
    name: 'deepseek',
    model: 'test-model',
    policyURL: 'https://example.test/policy',
    generate:
      generate ??
      (async ({ input }) => {
        const r = input as {
          document_id: string;
          source_blocks: ReturnType<typeof syntheticDocument>['blocks'];
        };
        return {
          output: nameExtraction({
            ...syntheticDocument(),
            document_id: r.document_id,
            blocks: r.source_blocks,
          }),
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }),
  };
}
async function session(app: ReturnType<typeof createApp>) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: { authorization: 'Bearer ' + token },
    payload: { workspace_id: crypto.randomUUID() },
  });
  expect(response.statusCode).toBe(201);
  return { authorization: 'Bearer ' + response.json().data.session_token };
}
async function wait(
  app: ReturnType<typeof createApp>,
  id: string,
  headers: { authorization: string },
) {
  for (let i = 0; i < 100; i++) {
    const response = await app.inject({
      url: '/v1/profile/parse/jobs/' + id,
      headers,
    });
    if (response.json().data?.status !== 'running') return response;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('job did not settle');
}
it('会话鉴权、完整解析与幂等重放，输出仍是候选而非确认事实', async () => {
  const generate = vi.fn(provider().generate);
  const app = createApp({ provider: provider(generate), apiToken: token });
  try {
    const headers = await session(app);
    const body = request();
    const started = await app.inject({
      method: 'POST',
      url: '/v1/profile/parse',
      headers,
      payload: body,
    });
    expect(started.statusCode).toBe(202);
    const id = started.json().data.job_id;
    const result = await wait(app, id, headers);
    expect(result.json().data).toMatchObject({
      status: 'succeeded',
      result: { extraction: { candidates: [{ value: '测试同学' }] } },
    });
    expect(JSON.stringify(result.json())).not.toContain('confirmed');
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/profile/parse',
      headers,
      payload: body,
    });
    expect(replay.json().data.job_id).toBe(id);
    expect(generate).toHaveBeenCalledTimes(1);
    const changed = structuredClone(body);
    changed.source_blocks[0]!.text += ' ';
    changed.source_blocks[0]!.end++;
    changed.consent.blocks_hash = createHash('sha256')
      .update(JSON.stringify(changed.source_blocks))
      .digest('hex');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/profile/parse',
          headers,
          payload: changed,
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await app.close();
  }
});
it('未经认证、错误授权范围和文档引用被拒绝', async () => {
  const app = createApp({ provider: provider(), apiToken: token });
  try {
    const body = request();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/profile/parse',
          payload: body,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/sessions',
          headers: { authorization: 'Bearer wrong' },
          payload: { workspace_id: 'test' },
        })
      ).statusCode,
    ).toBe(401);
    const headers = await session(app);
    for (const update of [
      { model: 'other-model' },
      { provider: 'other-provider' },
      { blocks_hash: '0'.repeat(64) },
      { granted_at: 0 },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/profile/parse',
            headers,
            payload: { ...body, consent: { ...body.consent, ...update } },
          })
        ).statusCode,
      ).toBe(403);
    body.source_blocks[0]!.document_id = 'unknown';
    body.consent.blocks_hash = createHash('sha256')
      .update(JSON.stringify(body.source_blocks))
      .digest('hex');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/profile/parse',
          headers,
          payload: body,
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});
it('另一个会话不能读取或删除任务；撤销会话会清理结果', async () => {
  const app = createApp({ provider: provider(), apiToken: token });
  try {
    const a = await session(app),
      b = await session(app);
    const start = await app.inject({
      method: 'POST',
      url: '/v1/profile/parse',
      headers: a,
      payload: request(),
    });
    const id = start.json().data.job_id;
    for (const method of ['GET', 'DELETE'] as const)
      expect(
        (
          await app.inject({
            method,
            url: '/v1/profile/parse/jobs/' + id,
            headers: b,
          })
        ).statusCode,
      ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/v1/sessions/current',
          headers: a,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: '/v1/profile/parse/jobs/' + id, headers: a }))
        .statusCode,
    ).toBe(401);
  } finally {
    await app.close();
  }
});
it('非法模型输出、伪造引用和拒绝都不生成可用事实', async () => {
  for (const [generate, code] of [
    [
      async () => ({
        output: { wrong: 'PRIVATE_VALUE' },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      'MODEL_INVALID_OUTPUT',
    ],
    [
      async () => {
        throw new ModelFault('MODEL_REFUSED');
      },
      'MODEL_REFUSED',
    ],
    [
      async () => ({
        output: {
          candidates: [
            {
              category: 'basic',
              path: 'basic.name',
              value: '测试同学',
              entity_key: 'basic',
              block_id: 'unknown',
              quote: '姓名：测试同学',
            },
          ],
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      'EVIDENCE_INVALID',
    ],
  ] as const) {
    const app = createApp({ provider: provider(generate), apiToken: token });
    try {
      const headers = await session(app);
      const start = await app.inject({
        method: 'POST',
        url: '/v1/profile/parse',
        headers,
        payload: request(),
      });
      const result = await wait(app, start.json().data.job_id, headers);
      expect(result.json().data).toMatchObject({
        status: 'failed',
        result: null,
        error_code: code,
      });
      expect(result.body).not.toContain('PRIVATE_VALUE');
    } finally {
      await app.close();
    }
  }
});
it('模型超时明确失败，迟到结果不能复活任务', async () => {
  const app = createApp({
    provider: provider(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return {
        output: { candidates: [] },
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }),
    apiToken: token,
    parseTimeoutMs: 10,
  });
  try {
    const headers = await session(app);
    const start = await app.inject({
      method: 'POST',
      url: '/v1/profile/parse',
      headers,
      payload: request(),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await wait(app, start.json().data.job_id, headers);
    expect(result.json().data).toMatchObject({
      status: 'failed',
      result: null,
      error_code: 'MODEL_TIMEOUT',
    });
  } finally {
    await app.close();
  }
});
it('任务 TTL 到期后不可读取，日志不含请求正文或令牌', async () => {
  const logs: Record<string, unknown>[] = [];
  const app = createApp({
    provider: provider(),
    apiToken: token,
    jobTtlMs: 10,
    logSink: (r) => logs.push(r),
  });
  try {
    const headers = await session(app);
    const start = await app.inject({
      method: 'POST',
      url: '/v1/profile/parse',
      headers,
      payload: request(),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      (
        await app.inject({
          url: '/v1/profile/parse/jobs/' + start.json().data.job_id,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(JSON.stringify(logs)).not.toContain(token);
    expect(JSON.stringify(logs)).not.toContain('测试同学');
  } finally {
    await app.close();
  }
});
it('无模型配置不允许创建解析会话', async () => {
  const app = createApp();
  try {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/sessions',
          payload: { workspace_id: 'test' },
        })
      ).statusCode,
    ).toBe(503);
  } finally {
    await app.close();
  }
});
