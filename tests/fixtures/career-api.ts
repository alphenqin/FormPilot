import { createApp } from '../../apps/api/src/app';
const app = createApp({
  apiToken: 'c'.repeat(64),
  provider: {
    name: 'deepseek',
    model: 'controlled-career-model',
    policyURL: 'https://example.test/policy',
    async generate({ operation, input }) {
      if (
        operation !== 'jd_parse' ||
        Object.keys(input as object).join(',') !== 'text'
      )
        throw new Error('Unexpected payload');
      await new Promise((r) => setTimeout(r, 1800));
      return {
        output: {
          attributes: [
            {
              key: 'title',
              value: '合成后端工程师',
              quote: '职位：合成后端工程师',
            },
          ],
          requirements: [
            {
              kind: 'education',
              priority: 'hard',
              quote: '本科及以上学历。',
              term: null,
            },
            {
              kind: 'skill',
              priority: 'core',
              quote: '熟练掌握Java。',
              term: 'Java',
            },
            {
              kind: 'experience',
              priority: 'hard',
              quote: '至少3年工作经验。',
              term: null,
            },
          ],
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  },
});
await app.listen({ host: '127.0.0.1', port: 4318 });
process.on('SIGTERM', () => {
  void app.close().then(() => process.exit(0));
});
