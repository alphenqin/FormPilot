import { PlanStore } from './plan-store';
import { fileURLToPath } from 'node:url';
import { getModelProvider } from '@formpilot/ai';
import { createApp } from './app';
import { readServerConfig } from '@formpilot/config';
let provider;
try {
  provider = getModelProvider(process.env);
} catch {
  /* 缺少配置时 health 可用，业务接口明确拒绝 */
}
let planStore: PlanStore | null = null;
try {
  const key = process.env.FORMPILOT_DATA_KEY;
  if (key && /^[a-f0-9]{64}$/.test(key))
    planStore = new PlanStore(
      Buffer.from(key, 'hex'),
      fileURLToPath(
        new URL('../../../.runtime/formpilot.sqlite', import.meta.url),
      ),
    );
} catch {
  process.stderr.write(
    '计划加密存储不可用，请检查 FORMPILOT_DATA_KEY 和运行目录\n',
  );
}
const app = createApp({
  planStore,
  logging: true,
  ...(provider ? { provider } : {}),
  ...(process.env.FORMPILOT_API_TOKEN
    ? { apiToken: process.env.FORMPILOT_API_TOKEN }
    : {}),
});
try {
  await app.listen(readServerConfig(process.env));
} catch {
  process.stderr.write('FormPilot API 启动失败，请检查配置与端口\n');
  process.exit(1);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
