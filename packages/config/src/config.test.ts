import { it, expect } from 'vitest';
import { readServerConfig, logRecord } from './index';
it('配置默认值和端口边界', () => {
  expect(readServerConfig({})).toEqual({ host: '127.0.0.1', port: 4318 });
  for (const port of ['0', '65536', '1.1', '4318oops', ''])
    expect(() => readServerConfig({ FORMPILOT_PORT: port })).toThrow();
  expect(() => readServerConfig({ FORMPILOT_HOST: '0.0.0.0' })).toThrow();
});
it('日志只输出白名单元数据', () => {
  expect(
    logRecord({
      event: 'request',
      request_id: 'id',
      status_code: 400,
      duration_ms: 1,
      body: { resume: 'secret' },
      authorization: 'secret',
      url: '/secret',
    }),
  ).toEqual({
    event: 'request',
    request_id: 'id',
    status_code: 400,
    duration_ms: 1,
  });
});
