import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  isMessage,
  failure,
  FailureEnvelopeSchema,
  parseHealth,
  parseBridgeResponse,
} from './index';
describe('传输契约', () => {
  const base = {
    protocol_version: '1',
    request_id: 'test-1',
    task_id: null,
    method: 'ping',
    session_token: 'a'.repeat(64),
  };
  it('仅接受完整的版本化消息', () => {
    expect(isMessage(base)).toBe(true);
    for (const value of [
      { ...base, protocol_version: '2' },
      { ...base, task_id: 'secret' },
      { ...base, method: 'execute' },
      { ...base, extra: 'sensitive' },
      { ...base, session_token: 'short' },
      null,
    ])
      expect(isMessage(value)).toBe(false);
  });
  it('错误不回显输入', () => {
    expect(
      Value.Check(
        FailureEnvelopeSchema,
        failure('test', 'UNAUTHORIZED', '需要配对'),
      ),
    ).toBe(true);
  });
  it('不将错误或畸形响应视为连接成功', () => {
    for (const value of [
      null,
      { data: { status: 'ok' } },
      failure('test', 'SERVICE_UNAVAILABLE', '不可用'),
      {
        request_id: 'test',
        data: { status: 'ok', service: 'other', protocol_version: '1' },
        error: null,
      },
    ])
      expect(() => parseHealth(value)).toThrow();
  });
});

it('桥接响应必须绑定请求并符合结果契约', () => {
  const response = {
    request_id: 'req',
    data: { pong: true, protocol_version: '1', api_connected: false },
    error: null,
  };
  expect(parseBridgeResponse(response, 'req').data?.api_connected).toBe(false);
  for (const value of [
    { ...response, request_id: 'wrong' },
    { ...response, data: null },
    {
      ...response,
      data: { pong: true, protocol_version: '1', api_connected: 'yes' },
    },
  ])
    expect(() => parseBridgeResponse(value, 'req')).toThrow();
});
