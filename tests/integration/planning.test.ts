import { it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from '../../apps/api/src/app';
import { PlanStore } from '../../apps/api/src/plan-store';
import {
  hashJson,
  planConsentPayload,
  type FillPlanRequest,
  type FillPlanView,
} from '@formpilot/contracts';
import { ModelFault, type ModelProvider } from '@formpilot/ai';
import { planningRequest, field } from '../fixtures/planning';
const token = 'local-test-token';
function provider(generate?: ModelProvider['generate']): ModelProvider {
  return {
    name: 'deepseek',
    model: 'test-model',
    policyURL: 'https://example.test/policy',
    generate:
      generate ??
      (async () => ({
        output: { mappings: [] },
        usage: { input_tokens: 1, output_tokens: 1 },
      })),
  };
}
async function session(
  app: ReturnType<typeof createApp>,
  workspace = 'workspace-1',
) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: { authorization: 'Bearer ' + token },
    payload: { workspace_id: workspace },
  });
  expect(res.statusCode).toBe(201);
  return { authorization: 'Bearer ' + res.json().data.session_token };
}
function post(
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
  path: string,
  body: { client_request_id: string; [key: string]: unknown },
) {
  return app.inject({
    method: 'POST',
    url: '/v1/fill/' + path,
    headers: { ...headers, 'idempotency-key': body.client_request_id },
    payload: body,
  });
}
const resolve = (v: FillPlanView) => ({
  schema_version: 1,
  client_request_id: crypto.randomUUID(),
  task_id: v.task_id,
  plan_id: v.plan_id,
  expected_plan_revision: v.plan_revision,
  answers: [],
  resolutions: [],
});
const approval = (v: FillPlanView) => ({
  ...resolve(v),
  answers: undefined,
  resolutions: undefined,
  plan_digest: v.plan_digest,
  approved_field_ids: v.field_decisions
    .filter((d) => d.decision === 'fill')
    .map((d) => d.field_id),
  observed_profile_revision: v.profile_revision,
  observed_snapshot_ref: v.snapshot_ref,
  observed_at: Date.now(),
});
async function consent(r: FillPlanRequest) {
  r.consent.payload_hash = await hashJson(planConsentPayload(r));
  return r;
}
it('计划→补答→新版本→批准；旧计划、未知字段、越界任务与伪批准均拒绝', async () => {
  const app = createApp({ provider: provider(), apiToken: token });
  try {
    const h = await session(app),
      r = await planningRequest([field(), field('意向城市', 'field-2')]);
    const response = await post(app, h, 'plan', r);
    expect(response.statusCode, response.body).toBe(200);
    const p = response.json().data as FillPlanView;
    expect(p.status).toBe('WAITING_USER');
    const out = await post(app, h, 'resolve', {
      ...resolve(p),
      answers: [
        {
          question_id: p.questions[0]!.question_id,
          value: '上海',
          precision: null,
          scope: 'task',
        },
      ],
    });
    expect(out.statusCode, out.body).toBe(200);
    const v = out.json().data as FillPlanView;
    expect(v.plan_revision).toBe(2);
    expect(v.user_approval).toBeNull();
    expect(v.task_answers[0]?.scope).toBe('task');
    expect((await post(app, h, 'approve', approval(p))).statusCode).toBe(409);
    expect(
      (
        await post(app, h, 'approve', {
          ...approval(v),
          approved_field_ids: ['invented'],
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await post(app, h, 'approve', { ...approval(v), approved: true }))
        .statusCode,
    ).toBe(400);
    const approve = await post(app, h, 'approve', approval(v));
    expect(approve.statusCode, approve.body).toBe(200);
    expect(approve.json().data.status).toBe('READY');
    expect(approve.json().data.application_submitted).toBe(false);
    const other = await session(app, 'other-workspace');
    expect(
      (await app.inject({ url: '/v1/fill/tasks/' + v.task_id, headers: other }))
        .statusCode,
    ).toBe(404);
    const revised = await post(app, h, 'resolve', {
      ...resolve(v),
      resolutions: [
        {
          type: 'edit',
          field_id: 'field-1',
          value: '用户修改',
          precision: null,
        },
      ],
    });
    expect(revised.statusCode, revised.body).toBe(200);
    expect(revised.json().data.user_approval).toBeNull();
    expect(revised.json().data.plan_revision).toBe(3);
  } finally {
    await app.close();
  }
});
it('幂等并发只调用一次模型，不同请求体冲突；并发修订只有一个成功', async () => {
  const generate = vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 20));
    return {
      output: { mappings: [] },
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  });
  const app = createApp({ provider: provider(generate), apiToken: token });
  try {
    const h = await session(app),
      r = await planningRequest();
    const [a, b] = await Promise.all([
      post(app, h, 'plan', r),
      post(app, h, 'plan', r),
    ]);
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().data).toEqual(b.json().data);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(
      (await post(app, h, 'plan', { ...r, profile_revision: 2 })).json().error
        .code,
    ).toBe('IDEMPOTENCY_CONFLICT');
    const v = a.json().data as FillPlanView;
    const results = await Promise.all([
      post(app, h, 'resolve', resolve(v)),
      post(app, h, 'resolve', resolve(v)),
    ]);
    expect(results.map((x) => x.statusCode).sort()).toEqual([200, 409]);
  } finally {
    await app.close();
  }
});
it('资料或页面失效清除批准，幂等重放不会复活旧批准', async () => {
  const app = createApp({ provider: provider(), apiToken: token });
  try {
    const h = await session(app),
      p = (await post(app, h, 'plan', await planningRequest())).json()
        .data as FillPlanView;
    const req = approval(p);
    expect((await post(app, h, 'approve', req)).json().data.status).toBe(
      'READY',
    );
    const invalid = await post(app, h, 'invalidate', {
      ...resolve(p),
      answers: undefined,
      resolutions: undefined,
      reason: 'PAGE_CHANGED',
    });
    expect(invalid.statusCode, invalid.body).toBe(200);
    expect(invalid.json().data.user_approval).toBeNull();
    expect((await post(app, h, 'approve', req)).json().data.status).toBe(
      'DRAFT',
    );
    expect((await post(app, h, 'resolve', resolve(p))).json().error.code).toBe(
      'STALE_PLAN',
    );
  } finally {
    await app.close();
  }
});
it('同意摘要、供应商、时效、快照作用域及来源证据均强制校验', async () => {
  const app = createApp({ provider: provider(), apiToken: token });
  try {
    const h = await session(app);
    for (const change of [
      'consent',
      'provider',
      'age',
      'scope',
      'evidence',
    ] as const) {
      const r = await planningRequest();
      if (change === 'consent') r.confirmed_facts[0]!.value = '篡改';
      if (change === 'provider') r.consent.provider = 'other';
      if (change === 'age') {
        r.form_snapshot.captured_at = 0;
        await consent(r);
      }
      if (change === 'scope') {
        r.form_snapshot.task_id = 'other';
        await consent(r);
      }
      if (change === 'evidence') {
        r.confirmed_facts[0]!.source_type = 'resume';
        await consent(r);
      }
      const res = await post(app, h, 'plan', r);
      expect(res.statusCode, res.body).not.toBe(200);
    }
    expect(
      (await post(app, {}, 'plan', await planningRequest())).statusCode,
    ).toBe(401);
  } finally {
    await app.close();
  }
});
it('模型超时、坏输出与拒绝均降级；不生成未经审核可用的事实值', async () => {
  for (const mode of ['timeout', 'invalid', 'refusal']) {
    const app = createApp({
      provider: provider(
        mode === 'timeout'
          ? async () => new Promise(() => {})
          : mode === 'invalid'
            ? async () => ({
                output: {
                  mappings: [
                    {
                      field_id: 'fabricated',
                      path: 'basic.name',
                      entity_id: null,
                    },
                  ],
                },
                usage: { input_tokens: 1, output_tokens: 1 },
              })
            : async () => {
                throw new ModelFault('MODEL_REFUSED');
              },
      ),
      apiToken: token,
      planTimeoutMs: 5,
    });
    try {
      const h = await session(app),
        res = await post(app, h, 'plan', await planningRequest());
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data.degraded).toBe(true);
      expect(res.json().data.field_decisions[0].decision).toBe('review');
    } finally {
      await app.close();
    }
  }
});
it('SQLite 加密落盘与服务重启恢复；未完成的模型调用不会在重启后重付费', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'formpilot-plans-')),
    path = join(dir, 'plans.sqlite'),
    key = randomBytes(32),
    r = await planningRequest();
  let store = new PlanStore(key, path),
    app = createApp({
      provider: provider(),
      apiToken: token,
      planStore: store,
    });
  try {
    let h = await session(app);
    const response = await post(app, h, 'plan', r);
    expect(response.statusCode, response.body).toBe(200);
    const v = response.json().data;
    await app.close();
    expect(
      readFileSync(path).includes(Buffer.from('PLAN_PRIVATE_SENTINEL')),
    ).toBe(false);
    expect(readFileSync(path).includes(Buffer.from('workspace-1'))).toBe(false);
    store = new PlanStore(key, path);
    const unfinished = await planningRequest();
    store.reserve(
      'workspace-1',
      unfinished.client_request_id,
      await hashJson({ path: '/v1/fill/plan', body: unfinished }),
    );
    const generate = vi.fn(provider().generate);
    app = createApp({
      provider: provider(generate),
      apiToken: token,
      planStore: store,
    });
    h = await session(app);
    expect(
      (await app.inject({ url: '/v1/fill/tasks/task-1', headers: h })).json()
        .data,
    ).toEqual(v);
    expect((await post(app, h, 'plan', r)).json().data).toEqual(v);
    expect(generate).not.toHaveBeenCalled();
    expect((await post(app, h, 'plan', unfinished)).json().error.code).toBe(
      'TASK_INTERRUPTED',
    );
    expect(generate).not.toHaveBeenCalled();
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('删除会话同时清除工作空间计划，日志不包含输入事实', async () => {
  const logs: unknown[] = [];
  const app = createApp({
    provider: provider(),
    apiToken: token,
    logSink: (r) => logs.push(r),
  });
  try {
    let h = await session(app);
    expect(
      (await post(app, h, 'plan', await planningRequest())).statusCode,
    ).toBe(200);
    await app.inject({
      method: 'DELETE',
      url: '/v1/sessions/current',
      headers: h,
    });
    h = await session(app);
    expect(
      (await app.inject({ url: '/v1/fill/tasks/task-1', headers: h }))
        .statusCode,
    ).toBe(404);
    expect(JSON.stringify(logs)).not.toContain('PLAN_PRIVATE_SENTINEL');
  } finally {
    await app.close();
  }
});
it('没有执行检查点时不能伪造核验成功', async () => {
  const app = createApp({ provider: provider(), apiToken: token });
  try {
    const h = await session(app),
      p = (await post(app, h, 'plan', await planningRequest())).json()
        .data as FillPlanView,
      v = (await post(app, h, 'approve', approval(p))).json()
        .data as FillPlanView;
    const body = {
      schema_version: 1,
      client_request_id: crypto.randomUUID(),
      task_id: v.task_id,
      plan_id: v.plan_id,
      plan_revision: v.plan_revision,
      form_snapshot_id: v.form_snapshot_id,
      user_approval: v.user_approval,
      execution_report: {
        execution_id: 'e1',
        started_at: Date.now(),
        ended_at: Date.now(),
        field_results: [],
      },
    };
    const response = await post(app, h, 'verify', body);
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().error.code).toBe('REFERENCE_NOT_FOUND');
    expect(
      (
        await post(app, h, 'verify', {
          ...body,
          user_approval: { ...v.user_approval, approval_id: 'invented' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await post(app, h, 'verify', { ...body, success: true })).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});
it('缺少加密存储时 health 正常，计划能力明确关闭', async () => {
  const app = createApp({
    provider: provider(),
    apiToken: token,
    planStore: null,
  });
  try {
    const h = await session(app),
      caps = (await app.inject('/v1/system/capabilities')).json().data;
    expect(caps.planning_available).toBe(false);
    expect(
      (await post(app, h, 'plan', await planningRequest())).statusCode,
    ).toBe(503);
  } finally {
    await app.close();
  }
});
it('删除工作空间期间的迟到模型结果不能复活计划', async () => {
  let finish: (() => void) | undefined;
  const generate = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      output: { mappings: [] },
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  });
  const app = createApp({ provider: provider(generate), apiToken: token });
  try {
    let h = await session(app);
    const r = await planningRequest(),
      request = post(app, h, 'plan', r);
    const result = Promise.resolve(request);
    for (let i = 0; i < 50 && !finish; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(finish).toBeDefined();
    await app.inject({
      method: 'DELETE',
      url: '/v1/sessions/current',
      headers: h,
    });
    finish!();
    expect((await result).statusCode).not.toBe(200);
    h = await session(app);
    expect(
      (await app.inject({ url: '/v1/fill/tasks/task-1', headers: h }))
        .statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});
