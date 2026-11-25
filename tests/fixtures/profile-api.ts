// 仅测试目录可控模型替身；生产 server 不读取任何模拟开关。
import { createApp } from '../../apps/api/src/app';
import type { ModelProvider } from '@formpilot/ai';
const provider: ModelProvider = {
  name: 'deepseek',
  model: 'controlled-test-model',
  policyURL: 'https://example.test/policy',
  async generate({ input, signal }) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1500);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
    const r = input as { source_blocks: { block_id: string; text: string }[] };
    const b = r.source_blocks[0]!;
    const name = /姓名：([^\n]+)/.exec(b.text)?.[1] ?? '测试同学';
    return {
      output: {
        candidates: [
          {
            category: 'basic',
            path: 'basic.name',
            value: name,
            entity_key: '基本信息',
            block_id: b.block_id,
            quote: '姓名：' + name,
          },
        ],
      },
      usage: { input_tokens: 10, output_tokens: 10 },
    };
  },
};
const app = createApp({ provider, apiToken: 'c'.repeat(64) });
await app.listen({ host: '127.0.0.1', port: 4318 });
process.on('SIGTERM', () => {
  void app.close().then(() => process.exit(0));
});
