import { getModelProvider, parseResume, ModelFault } from '@formpilot/ai';
import { blocksFromPages } from '@formpilot/domain';
import { createHash } from 'node:crypto';
const provider = getModelProvider(process.env);
const document_id = crypto.randomUUID();
const source_blocks = blocksFromPages(document_id, [
  {
    page: null,
    text: '测试简历（完全虚构，仅用于接口验证）\n姓名：张岚\n邮箱：synthetic@example.test\n教育：示例大学，计算机科学，本科，2020年9月 至 2024年6月。',
  },
]);
try {
  const result = await parseResume(
    provider,
    {
      client_request_id: crypto.randomUUID(),
      document_id,
      document_revision: 1,
      source_blocks,
      consent: {
        granted: true,
        purpose: 'resume_parse',
        provider: provider.name,
        model: provider.model,
        policy_url: provider.policyURL,
        blocks_hash: createHash('sha256')
          .update(JSON.stringify(source_blocks))
          .digest('hex'),
        granted_at: Date.now(),
      },
    },
    AbortSignal.timeout(60000),
  );
  process.stdout.write(
    JSON.stringify({
      sample: 'synthetic-not-real-resume',
      provider: result.provider,
      model: result.model,
      candidates: result.extraction.candidates.length,
      all_pending: true,
      usage: result.usage,
      duration_ms: result.duration_ms,
    }) + '\n',
  );
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      sample: 'synthetic-not-real-resume',
      error_code:
        error instanceof ModelFault ? error.code : 'VALIDATION_FAILED',
    }) + '\n',
  );
  process.exitCode = 1;
}
