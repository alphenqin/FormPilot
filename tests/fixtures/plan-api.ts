import { createApp } from '../../apps/api/src/app';
const app = createApp({
  apiToken: 'c'.repeat(64),
  provider: {
    name: 'deepseek',
    model: 'controlled-plan-model',
    policyURL: 'https://example.test/policy',
    async generate() {
      return {
        output: { mappings: [] },
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  },
});
await app.listen({ host: '127.0.0.1', port: 4318 });
process.on('SIGTERM', () => {
  void app.close().then(() => process.exit(0));
});
