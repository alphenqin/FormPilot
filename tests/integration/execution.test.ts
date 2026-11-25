import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { PlanStore } from '../../apps/api/src/plan-store';
import {
  executionApp,
  executionSession,
  executionPost as post,
  approvedExecutionPlan,
  beginExecution,
  executionStep,
  completedExecution,
  verification,
} from '../fixtures/execution-api';
import type { ExecutionView, ExecutionFieldResult } from '@formpilot/contracts';
it('批准→执行锁→逐字段检查点→最终核验，报告始终未提交', async () => {
  const app = executionApp();
  try {
    const h = await executionSession(app),
      p = await approvedExecutionPlan(app, h);
    const res = await post(app, h, 'executions/begin', beginExecution(p));
    expect(res.statusCode, res.body).toBe(200);
    const e = await completedExecution(app, h, res.json().data);
    const verified = await post(app, h, 'verify', verification(p, e));
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().data).toMatchObject({
      verified_fields: ['field-1'],
      failed_fields: [],
      status: 'REVIEW',
      application_submitted: false,
    });
    expect(
      (
        await app.inject({ url: '/v1/fill/tasks/' + p.task_id, headers: h })
      ).json().data.status,
    ).toBe('REVIEW');
  } finally {
    await app.close();
  }
});
it('错误批准、错页、错资料版本、未知字段和缺少幂等头不能开始', async () => {
  const app = executionApp();
  try {
    const h = await executionSession(app),
      p = await approvedExecutionPlan(app, h);
    for (const change of [
      { plan_digest: 'f'.repeat(64) },
      { observed_profile_revision: p.profile_revision + 1 },
      { field_ids: ['invented'] },
      {
        observed_snapshot_ref: { ...p.snapshot_ref, page_instance_id: 'other' },
      },
    ]) {
      const r = await post(app, h, 'executions/begin', {
        ...beginExecution(p),
        ...change,
      });
      expect(r.statusCode, r.body).not.toBe(200);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/fill/executions/begin',
          headers: h,
          payload: beginExecution(p),
        })
      ).statusCode,
    ).not.toBe(200);
  } finally {
    await app.close();
  }
});
it('工作空间全局执行锁、并发幂等及执行期间修订阻断', async () => {
  const app = executionApp();
  try {
    const h = await executionSession(app),
      p = await approvedExecutionPlan(app, h),
      p2 = await approvedExecutionPlan(app, h, 'task-2'),
      req = beginExecution(p);
    const [a, b] = await Promise.all([
      post(app, h, 'executions/begin', req),
      post(app, h, 'executions/begin', req),
    ]);
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().data.packet.execution_id).toBe(
      b.json().data.packet.execution_id,
    );
    const busy = await post(app, h, 'executions/begin', beginExecution(p2));
    expect(busy.json().error.code).toBe('EXECUTION_LOCKED');
    const r = await post(app, h, 'resolve', {
      schema_version: 1,
      client_request_id: crypto.randomUUID(),
      task_id: p.task_id,
      plan_id: p.plan_id,
      expected_plan_revision: p.plan_revision,
      answers: [],
      resolutions: [],
    });
    expect(r.json().error.code).toBe('EXECUTION_LOCKED');
  } finally {
    await app.close();
  }
});
it('未写检查点、伪造成功、乱序 epoch/sequence 与篡改目标均拒绝', async () => {
  const app = executionApp();
  try {
    const h = await executionSession(app),
      p = await approvedExecutionPlan(app, h),
      e = (await post(app, h, 'executions/begin', beginExecution(p))).json()
        .data as ExecutionView,
      item = e.packet.items[0]!;
    const row: ExecutionFieldResult = {
      field_id: item.field.field_id,
      before: item.before,
      target: item.target,
      actual: item.target,
      status: 'verified',
      error_code: null,
    };
    for (const change of [
      {},
      { execution_epoch: e.packet.execution_epoch + 1 },
      { sequence: 10 },
      { field_result: { ...row, target: '伪造' } },
    ]) {
      const r = await post(app, h, 'executions/checkpoint', {
        ...executionStep(e, 'after', row),
        ...change,
      });
      expect(r.statusCode, r.body).not.toBe(200);
    }
    const final = executionStep(e, 'completed');
    final.report!.field_results = [row];
    final.written_field_ids = [row.field_id];
    expect(
      (await post(app, h, 'executions/checkpoint', final)).statusCode,
    ).not.toBe(200);
    expect(
      (
        await post(
          app,
          h,
          'verify',
          verification(p, {
            ...e,
            report: { ...e.report, field_results: [row] },
          }),
        )
      ).statusCode,
    ).not.toBe(200);
  } finally {
    await app.close();
  }
});
it('核验必须逐项匹配服务端记录，改值、删项、重复项、假批准都拒绝', async () => {
  const app = executionApp();
  try {
    const h = await executionSession(app),
      p = await approvedExecutionPlan(app, h),
      e = await completedExecution(
        app,
        h,
        (await post(app, h, 'executions/begin', beginExecution(p))).json().data,
      ),
      r = verification(p, e);
    for (const change of [
      { execution_report: { ...r.execution_report, field_results: [] } },
      {
        execution_report: {
          ...r.execution_report,
          field_results: [
            ...r.execution_report.field_results,
            ...r.execution_report.field_results,
          ],
        },
      },
      {
        execution_report: {
          ...r.execution_report,
          field_results: r.execution_report.field_results.map((f) => ({
            ...f,
            actual: '另一个值',
          })),
        },
      },
      { user_approval: { ...r.user_approval, approval_id: 'fake' } },
    ])
      expect(
        (
          await post(app, h, 'verify', {
            ...r,
            client_request_id: crypto.randomUUID(),
            ...change,
          })
        ).statusCode,
      ).not.toBe(200);
  } finally {
    await app.close();
  }
});
it('报告可降级但不能最终升级失败项；停止后不能再授权下一次写入', async () => {
  const app = executionApp();
  try {
    const h = await executionSession(app),
      p = await approvedExecutionPlan(app, h);
    let e = (await post(app, h, 'executions/begin', beginExecution(p))).json()
      .data as ExecutionView;
    const item = e.packet.items[0]!,
      row: ExecutionFieldResult = {
        field_id: item.field.field_id,
        before: item.before,
        target: item.target,
        actual: item.before,
        status: 'failed',
        error_code: 'EXECUTION_INTERRUPTED',
      };
    e = (
      await post(
        app,
        h,
        'executions/checkpoint',
        executionStep(e, 'before', row),
      )
    ).json().data;
    e = (
      await post(app, h, 'executions/checkpoint', {
        ...executionStep(e, 'after', {
          ...row,
          error_code: 'VALUE_NOT_PERSISTED',
        }),
        written_field_ids: [row.field_id],
      })
    ).json().data;
    const final = executionStep(e, 'completed');
    final.report!.field_results[0] = {
      ...row,
      actual: item.target,
      status: 'verified',
      error_code: null,
    };
    expect(
      (await post(app, h, 'executions/checkpoint', final)).statusCode,
    ).not.toBe(200);
    e = (
      await post(app, h, 'executions/cancel', {
        schema_version: 1,
        client_request_id: crypto.randomUUID(),
        task_id: p.task_id,
        execution_id: e.packet.execution_id,
      })
    ).json().data;
    expect(e.cancelled).toBe(true);
    expect(
      (
        await post(
          app,
          h,
          'executions/checkpoint',
          executionStep(e, 'before', row),
        )
      ).statusCode,
    ).not.toBe(200);
  } finally {
    await app.close();
  }
});
it('只有失败字段可单项重试，撤销只针对该记录实际写入字段', async () => {
  const app = executionApp();
  try {
    const h = await executionSession(app),
      p = await approvedExecutionPlan(app, h),
      first = await completedExecution(
        app,
        h,
        (await post(app, h, 'executions/begin', beginExecution(p))).json().data,
      );
    await post(app, h, 'verify', verification(p, first));
    const retry = await post(app, h, 'executions/begin', {
      ...beginExecution(p),
      action: 'retry',
      source_execution_id: first.packet.execution_id,
    });
    expect(retry.statusCode).not.toBe(200);
    const undo = await post(app, h, 'executions/begin', {
      ...beginExecution(p),
      action: 'undo',
      source_execution_id: first.packet.execution_id,
    });
    expect(undo.statusCode, undo.body).toBe(200);
    expect(undo.json().data.packet.items[0]).toMatchObject({
      before: 'PLAN_PRIVATE_SENTINEL',
      target: '',
    });
    const done = await completedExecution(app, h, undo.json().data);
    expect(done.packet.action).toBe('undo');
    const view = (
      await app.inject({ url: '/v1/fill/tasks/' + p.task_id, headers: h })
    ).json().data;
    expect(view.status).toBe('DRAFT');
    expect(view.user_approval).toBeNull();
  } finally {
    await app.close();
  }
});
it('服务重启保留锁和加密检查点；状态未知中断不当作成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'formpilot-m4-')),
    path = join(dir, 'plans.sqlite'),
    key = randomBytes(32);
  let app = executionApp({ planStore: new PlanStore(key, path) });
  try {
    let h = await executionSession(app);
    const p = await approvedExecutionPlan(app, h),
      p2 = await approvedExecutionPlan(app, h, 'task-2');
    const e = (await post(app, h, 'executions/begin', beginExecution(p))).json()
      .data as ExecutionView;
    await app.close();
    expect(
      readFileSync(path).includes(Buffer.from('PLAN_PRIVATE_SENTINEL')),
    ).toBe(false);
    app = executionApp({ planStore: new PlanStore(key, path) });
    h = await executionSession(app);
    expect(
      (await post(app, h, 'executions/begin', beginExecution(p2))).json().error
        .code,
    ).toBe('EXECUTION_LOCKED');
    const unknown = await post(app, h, 'executions/interrupt', {
      schema_version: 1,
      client_request_id: crypto.randomUUID(),
      task_id: p.task_id,
      execution_id: e.packet.execution_id,
    });
    expect(unknown.statusCode, unknown.body).toBe(200);
    expect(unknown.json().data.report.field_results[0]).toMatchObject({
      status: 'failed',
      actual: null,
      error_code: 'EXECUTION_INTERRUPTED',
    });
    const other = await executionSession(app, 'other');
    expect(
      (
        await app.inject({
          url: '/v1/fill/tasks/' + p.task_id + '/executions',
          headers: other,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await post(app, h, 'executions/begin', beginExecution(p2))).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('M3 SQLite v1 库原地迁移至 v2，既有表和执行锁均可用', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'formpilot-m4-migrate-')),
    path = join(dir, 'plans.sqlite'),
    key = randomBytes(32);
  const db = new DatabaseSync(path);
  db.exec(
    readFileSync(
      new URL('../../apps/api/migrations/0001_plans.sql', import.meta.url),
      'utf8',
    ),
  );
  db.close();
  const app = executionApp({ planStore: new PlanStore(key, path) });
  try {
    const h = await executionSession(app),
      p = await approvedExecutionPlan(app, h);
    expect(
      (await post(app, h, 'executions/begin', beginExecution(p))).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
    const migrated = new DatabaseSync(path);
    expect(
      Number(migrated.prepare('PRAGMA user_version').get()!.user_version),
    ).toBe(2);
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('最终回读发现页面/语义变化时清除批准，不能继续核验旧计划', async () => {
  const app = executionApp();
  try {
    const h = await executionSession(app),
      p = await approvedExecutionPlan(app, h);
    let e = (await post(app, h, 'executions/begin', beginExecution(p))).json()
      .data as ExecutionView;
    const item = e.packet.items[0]!,
      before: ExecutionFieldResult = {
        field_id: item.field.field_id,
        before: item.before,
        target: item.target,
        actual: item.before,
        status: 'failed',
        error_code: 'EXECUTION_INTERRUPTED',
      };
    e = (
      await post(
        app,
        h,
        'executions/checkpoint',
        executionStep(e, 'before', before),
      )
    ).json().data;
    e = (
      await post(app, h, 'executions/checkpoint', {
        ...executionStep(e, 'after', {
          ...before,
          status: 'verified',
          actual: item.target,
          error_code: null,
        }),
        written_field_ids: [before.field_id],
      })
    ).json().data;
    const final = executionStep(e, 'completed');
    final.report!.field_results[0] = {
      ...before,
      actual: null,
      error_code: 'PAGE_CHANGED',
    };
    const response = await post(app, h, 'executions/checkpoint', final);
    expect(response.statusCode, response.body).toBe(200);
    const view = (
      await app.inject({ url: '/v1/fill/tasks/' + p.task_id, headers: h })
    ).json().data;
    expect(view).toMatchObject({
      status: 'DRAFT',
      invalid_reason: 'PAGE_CHANGED',
      user_approval: null,
    });
    expect(
      (await post(app, h, 'verify', verification(p, response.json().data)))
        .statusCode,
    ).toBe(409);
  } finally {
    await app.close();
  }
});
it('大型有界报告到达业务守卫，不在填写后因旧小体积上限丢失；伪报告仍拒绝', async () => {
  const app = executionApp();
  try {
    const h = await executionSession(app),
      p = await approvedExecutionPlan(app, h),
      e = (await post(app, h, 'executions/begin', beginExecution(p))).json()
        .data as ExecutionView;
    const request = verification(p, e),
      text = '合成测试'.repeat(200);
    request.execution_report = {
      ...request.execution_report,
      field_results: Array.from({ length: 250 }, (_, i) => ({
        field_id: 'field-' + i,
        before: text,
        target: text,
        actual: text,
        status: 'verified',
        error_code: null,
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(request))).toBeGreaterThan(400000);
    const response = await post(app, h, 'verify', request);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().data).toBeNull();
  } finally {
    await app.close();
  }
});
