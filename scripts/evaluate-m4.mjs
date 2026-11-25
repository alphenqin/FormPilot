import { readdir, readFile, writeFile } from 'node:fs/promises';
const names = (await readdir('test-results')).filter((name) =>
  /^m4-standard-.*\.json$/.test(name),
);
if (names.length !== 30)
  throw new Error('需要30个标准任务结果，当前 ' + names.length);
const rows = await Promise.all(
  names.map((name) =>
    readFile('test-results/' + name, 'utf8').then(JSON.parse),
  ),
);
if (new Set(rows.map((r) => r.sample_id + ':' + r.template)).size !== 30)
  throw new Error('标准任务结果重复');
const sum = (k) => rows.reduce((a, r) => a + r[k], 0),
  percentile = (data, p) =>
    [...data].sort((a, b) => a - b)[Math.ceil(data.length * p) - 1];
const executed = sum('approved_execution_fields'),
  correct = sum('correct_first_write_fields'),
  fillable = sum('expected_fillable_fields'),
  errors = rows.flatMap((r) =>
    r.errors.map((error) => ({
      sample: r.sample_id,
      template: r.template,
      error,
    })),
  );
const result = {
  dataset: 'synthetic-1',
  kind: '30 synthetic resume/template component tasks; reviewed plans; controlled model; actual Chromium DOM',
  tasks: rows.length,
  correct_first_write: {
    numerator: correct,
    denominator: executed,
    ratio: correct / executed,
  },
  correct_automatic_coverage: {
    numerator: correct,
    denominator: fillable,
    ratio: correct / fillable,
  },
  remaining_ask_fields: fillable - executed,
  manual_fields: sum('manual_fields'),
  user_review_actions: sum('user_review_actions'),
  zero_tolerance_errors: errors,
  auto_submits: sum('submits'),
  task_latency_ms: {
    p50: percentile(
      rows.map((r) => r.task_duration_ms),
      0.5,
    ),
    p95: percentile(
      rows.map((r) => r.task_duration_ms),
      0.95,
    ),
  },
  field_checkpoint_latency_ms: {
    samples: rows.flatMap((r) => r.field_timings).length,
    p50: percentile(
      rows.flatMap((r) => r.field_timings.map((f) => f.duration_ms)),
      0.5,
    ),
    p95: percentile(
      rows.flatMap((r) => r.field_timings.map((f) => f.duration_ms)),
      0.95,
    ),
  },
  stable_window_ms: 500,
  real_resume_acceptance: false,
  real_site_acceptance: false,
};
await writeFile(
  'test-results/m4-summary.json',
  JSON.stringify(result, null, 2) + '\n',
);
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
if (
  errors.length ||
  result.auto_submits ||
  correct / executed < 0.95 ||
  correct / fillable < 0.8
)
  throw new Error('M4 合成任务指标未通过');
