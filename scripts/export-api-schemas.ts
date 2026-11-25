import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import {
  AnswerRequestSchema,
  AnswerTaskSchema,
  JobParseRequestSchema,
  JobParseTaskSchema,
  ParseRequestSchema,
  JobSchema,
  ParseResultSchema,
  FillPlanRequestSchema,
  FillPlanViewSchema,
  ResolveRequestSchema,
  VerifyRequestSchema,
  VerifyResultSchema,
  FailureEnvelopeSchema,
  envelope,
  BeginExecutionSchema,
  ExecutionCheckpointSchema,
  ExecutionCancelSchema,
  ExecutionViewSchema,
} from '@formpilot/contracts';
const schemas = {
  answers: {
    method: 'POST',
    path: '/v1/career/answers/generate',
    success_status: 202,
    request: AnswerRequestSchema,
    response: envelope(AnswerTaskSchema),
    recover_by_request: '/v1/career/answers/requests/:id',
    poll: '/v1/career/answers/jobs/:id',
    delete: '/v1/career/answers/jobs/:id',
  },
  career: {
    method: 'POST',
    path: '/v1/career/jd/parse',
    success_status: 202,
    request: JobParseRequestSchema,
    response: envelope(JobParseTaskSchema),
    poll: '/v1/career/jd/jobs/:id',
    delete: '/v1/career/jd/jobs/:id',
  },
  parse: {
    method: 'POST',
    path: '/v1/profile/parse',
    success_status: 202,
    request: ParseRequestSchema,
    response: envelope(JobSchema),
    completed_result: ParseResultSchema,
  },
  plan: {
    method: 'POST',
    path: '/v1/fill/plan',
    success_status: 200,
    request: FillPlanRequestSchema,
    response: envelope(FillPlanViewSchema),
  },
  resolve: {
    method: 'POST',
    path: '/v1/fill/resolve',
    success_status: 200,
    request: ResolveRequestSchema,
    response: envelope(FillPlanViewSchema),
  },
  execution: {
    endpoints: {
      begin: '/v1/fill/executions/begin',
      checkpoint: '/v1/fill/executions/checkpoint',
      cancel: '/v1/fill/executions/cancel',
      interrupt: '/v1/fill/executions/interrupt',
    },
    begin_request: BeginExecutionSchema,
    checkpoint_request: ExecutionCheckpointSchema,
    cancel_request: ExecutionCancelSchema,
    response: envelope(ExecutionViewSchema),
  },
  verify: {
    method: 'POST',
    path: '/v1/fill/verify',
    success_status: 200,
    available_in: 'M4',
    available: true,
    request: VerifyRequestSchema,
    response: envelope(VerifyResultSchema),
  },
};
await mkdir('docs/api/v1', { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  const path = 'docs/api/v1/' + name + '.json';
  const text = await format(
    JSON.stringify(
      { contract_version: 1, ...schema, failure: FailureEnvelopeSchema },
      null,
      2,
    ),
    { parser: 'json' },
  );
  if (process.argv.includes('--check')) {
    if ((await readFile(path, 'utf8')) !== text)
      throw new Error('接口契约需重新生成：' + path);
  } else await writeFile(path, text);
}
process.stdout.write(
  'API 契约已' + (process.argv.includes('--check') ? '校验' : '导出') + '\n',
);
