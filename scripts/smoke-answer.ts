import {
  getModelProvider,
  generateOpenAnswer,
  ModelFault,
} from '@formpilot/ai';
import { answerFixture } from '../tests/fixtures/answer';
try {
  const { input } = await answerFixture();
  const result = await generateOpenAnswer(
    getModelProvider(process.env),
    input,
    AbortSignal.timeout(60000),
  );
  process.stdout.write(
    JSON.stringify({
      sample: 'synthetic-open-question-only',
      provider: result.provider,
      model: result.model,
      citations: result.selection.citations.length,
      full_quotes_validated: true,
      generated_characters: result.generated_text.length,
      usage: result.usage,
      duration_ms: result.duration_ms,
      requires_user_edit_and_review: true,
    }) + '\n',
  );
} catch (e) {
  process.stderr.write(
    JSON.stringify({
      sample: 'synthetic-open-question-only',
      error_code: e instanceof ModelFault ? e.code : 'VALIDATION_FAILED',
    }) + '\n',
  );
  process.exitCode = 1;
}
