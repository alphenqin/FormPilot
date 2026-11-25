import {
  getModelProvider,
  parseJobDescription,
  ModelFault,
} from '@formpilot/ai';
import { jobSource } from '../tests/fixtures/career';
try {
  const result = await parseJobDescription(
    getModelProvider(process.env),
    jobSource(),
    AbortSignal.timeout(60000),
  );
  if (!result.requirements.length) throw new Error('No requirements');
  process.stdout.write(
    JSON.stringify({
      sample: 'synthetic-jd-only',
      provider: result.provider,
      model: result.model,
      requirements: result.requirements.length,
      attributes: result.attributes.length,
      usage: result.usage,
      duration_ms: result.duration_ms,
      all_pending: result.requirements.every((r) => !r.confirmed),
    }) + '\n',
  );
} catch (e) {
  process.stderr.write(
    JSON.stringify({
      sample: 'synthetic-jd-only',
      error_code: e instanceof ModelFault ? e.code : 'VALIDATION_FAILED',
    }) + '\n',
  );
  process.exitCode = 1;
}
