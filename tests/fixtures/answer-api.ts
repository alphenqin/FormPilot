import { createApp } from '../../apps/api/src/app';
import type { AnswerInput } from '@formpilot/contracts';
import { answerSelection } from './answer';
let calls = 0;
const app = createApp({
  apiToken: 'c'.repeat(64),
  provider: {
    name: 'deepseek',
    model: 'controlled-answer-model',
    policyURL: 'https://example.test/policy',
    async generate({ operation, input }) {
      if (operation !== 'answer_generate')
        throw new Error('Unexpected operation');
      calls++;
      await new Promise((r) => setTimeout(r, 1800));
      return {
        output: answerSelection(input as AnswerInput),
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  },
});
app.get('/test/calls', async () => ({ calls }));
await app.listen({ host: '127.0.0.1', port: 4318 });
process.on('SIGTERM', () => {
  void app.close().then(() => process.exit(0));
});
