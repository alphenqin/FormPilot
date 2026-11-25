import { requestHealth } from '../../apps/extension/src/background/health';
import { it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { createApp } from '../../apps/api/src/app';
import {
  HealthEnvelopeSchema,
  CapabilitiesEnvelopeSchema,
  FailureEnvelopeSchema,
  parseHealth,
} from '@formpilot/contracts';
it('health/capabilities 使用共享响应契约', async () => {
  const app = createApp();
  try {
    for (const [url, schema] of [
      ['/health', HealthEnvelopeSchema],
      ['/v1/system/capabilities', CapabilitiesEnvelopeSchema],
    ] as const) {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(200);
      expect(Value.Check(schema, response.json())).toBe(true);
    }
    expect(
      (await app.inject('/v1/system/capabilities')).json().data.model_available,
    ).toBe(false);
  } finally {
    await app.close();
  }
});
it('非法参数、未实现接口和超大请求明确失败且不泄露值', async () => {
  const records: Record<string, unknown>[] = [];
  const app = createApp({ logSink: (r) => records.push(r) });
  try {
    for (const options of [
      { url: '/health?resume=PRIVATE_SENTINEL', expected: 400 },
      {
        url: '/v1/fill/plan',
        method: 'POST' as const,
        payload: { resume: 'PRIVATE_SENTINEL' },
        expected: 400,
      },
      {
        url: '/missing',
        method: 'POST' as const,
        payload: { resume: 'PRIVATE_SENTINEL'.repeat(2000) },
        expected: 413,
      },
    ]) {
      const response = await app.inject(options);
      expect(response.statusCode).toBe(options.expected);
      expect(Value.Check(FailureEnvelopeSchema, response.json())).toBe(true);
      expect(response.body).not.toContain('PRIVATE_SENTINEL');
    }
    expect(JSON.stringify(records)).not.toContain('PRIVATE_SENTINEL');
    expect(records.length).toBe(3);
  } finally {
    await app.close();
  }
});
it('真实监听端口完成 HTTP 通信并记录延迟', async () => {
  const app = createApp();
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const timings: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const response = await fetch(address + '/health');
      expect(response.status).toBe(200);
      expect(parseHealth(await response.json()).data?.status).toBe('ok');
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        measurement: 'health',
        samples: 20,
        p50_ms: timings[9],
        p95_ms: timings[18],
      }),
    );
  } finally {
    await app.close();
  }
});

it('扩展网络客户端验证真实 API，服务停止后明确失败', async () => {
  const app = createApp();
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    expect((await requestHealth(address)).data?.status).toBe('ok');
  } finally {
    await app.close();
  }
  await expect(requestHealth(address)).rejects.toThrow();
});
