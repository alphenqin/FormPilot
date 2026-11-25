export interface ServerConfig {
  host: string;
  port: number;
}
export function readServerConfig(
  env: Record<string, string | undefined>,
): ServerConfig {
  const host = env.FORMPILOT_HOST ?? '127.0.0.1';
  const portText = env.FORMPILOT_PORT ?? '4318';
  if (host !== '127.0.0.1' && host !== '::1')
    throw new Error('M0 API 仅支持回环地址');
  if (!/^\d+$/.test(portText)) throw new Error('FORMPILOT_PORT 必须是整数');
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error('FORMPILOT_PORT 超出范围');
  return { host, port };
}
export const LOG_FIELDS = [
  'event',
  'request_id',
  'status_code',
  'duration_ms',
] as const;
export function logRecord(input: Record<string, unknown>) {
  return Object.fromEntries(
    LOG_FIELDS.filter((key) => Object.hasOwn(input, key)).map((key) => [
      key,
      input[key],
    ]),
  );
}
