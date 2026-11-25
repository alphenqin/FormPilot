import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, it, expect } from 'vitest';
import { Vault, validateState } from './index';
import { addManualFact } from '@formpilot/domain';
const password = 'a-strong-test-passphrase';
const all: Vault[] = [];
function instance(name = 'test-' + crypto.randomUUID()) {
  const v = new Vault(name);
  all.push(v);
  return v;
}
afterEach(() => {
  for (const v of all.splice(0)) v.close();
});
it('数据库及备份没有事实明文，锁定和重新解锁可恢复', async () => {
  const name = 'test-' + crypto.randomUUID(),
    v = instance(name);
  let p = await v.create(password);
  p = addManualFact(p, 'basic.name', 'PRIVATE_VAULT_SENTINEL', null);
  await v.save(p);
  const raw = new Dexie(name);
  raw.version(1).stores({ records: 'id' });
  expect(JSON.stringify(await raw.table('records').toArray())).not.toContain(
    'PRIVATE_VAULT_SENTINEL',
  );
  raw.close();
  const backup = await v.backup();
  expect(backup).not.toContain('PRIVATE_VAULT_SENTINEL');
  v.lock();
  await expect(v.save(p)).rejects.toThrow();
  await expect(v.unlock('wrong-passphrase')).rejects.toThrow();
  expect((await v.unlock(password)).facts[0]!.value).toBe(
    'PRIVATE_VAULT_SENTINEL',
  );
});
it('并发窗口 CAS 阻止覆盖新版本', async () => {
  const name = 'test-' + crypto.randomUUID(),
    a = instance(name),
    b = instance(name);
  const p = await a.create(password);
  await b.unlock(password);
  await a.save(addManualFact(p, 'basic.name', '新值', null));
  await expect(
    b.save(addManualFact(p, 'basic.name', '旧窗口值', null)),
  ).rejects.toThrow('其他窗口');
  expect((await b.unlock(password)).facts[0]!.value).toBe('新值');
});
it('更新口令使旧口令失效，旧窗口不能还原旧密钥', async () => {
  const name = 'test-' + crypto.randomUUID(),
    a = instance(name),
    b = instance(name);
  const p = await a.create(password);
  await b.unlock(password);
  await a.changePassword(password, 'new-strong-test-passphrase');
  await expect(b.save(p)).rejects.toThrow();
  a.lock();
  await expect(a.unlock(password)).rejects.toThrow();
  expect((await a.unlock('new-strong-test-passphrase')).workspace_id).toBe(
    p.workspace_id,
  );
});
it('备份恢复检查口令、版本和 AAD，禁止覆盖已有资料库', async () => {
  const a = instance(),
    b = instance();
  const p = await a.create(password);
  await a.save(addManualFact(p, 'basic.email', 'synthetic@example.test', null));
  const backup = await a.backup();
  await expect(b.restore(backup, 'wrong-password')).rejects.toThrow();
  const changed = JSON.parse(backup);
  changed.workspace_id = 'tampered';
  await expect(b.restore(JSON.stringify(changed), password)).rejects.toThrow();
  changed.schema_version = 2;
  await expect(b.restore(JSON.stringify(changed), password)).rejects.toThrow();
  await b.restore(backup, password);
  await expect(b.restore(backup, password)).rejects.toThrow('删除现有');
  expect((await b.unlock(password)).facts[0]!.value).toBe(
    'synthetic@example.test',
  );
});
it('删除后无加密记录、旧实例不能复活数据，可重新建立', async () => {
  const name = 'test-' + crypto.randomUUID(),
    a = instance(name),
    b = instance(name);
  const p = await a.create(password);
  await b.unlock(password);
  await a.deleteAll();
  expect(await a.exists()).toBe(false);
  await expect(b.save(p)).rejects.toThrow();
  const fresh = await a.create(password);
  expect(fresh.workspace_id).not.toBe(p.workspace_id);
  expect(fresh.facts).toEqual([]);
});
it('锁定期间的异步解锁不能重新启用密钥', async () => {
  const a = instance();
  await a.create(password);
  a.lock();
  const pending = a.unlock(password);
  a.lock();
  await expect(pending).rejects.toThrow();
  expect(a.unlocked).toBe(false);
});
it('未知或损坏的明文 schema 被拒绝', () => {
  expect(() => validateState({ schema_version: 2 })).toThrow();
  expect(() => validateState({})).toThrow();
});
it('同窗计划与事实并发保存串行合并，过期计划响应不能覆盖新批准/失效状态', async () => {
  const { planningRequest } = await import('../../../tests/fixtures/planning');
  const { newPlanningContext, buildFillPlan } = await import(
    '@formpilot/domain'
  );
  const request = await planningRequest(),
    core = await buildFillPlan(newPlanningContext(request, { mappings: [] }), {
      plan_id: 'plan-local',
      plan_revision: 1,
      expires_at: Date.now() + 60000,
      usage: { input_tokens: 0, output_tokens: 0 },
      duration_ms: 0,
    });
  const task: import('@formpilot/contracts').LocalFillTask = {
    task_id: core.task_id,
    latest: {
      ...core,
      status: 'PLANNED',
      state_revision: 1,
      user_approval: null,
      invalid_reason: null,
    },
    history: [],
    invalid_reason: null,
    saved_at: Date.now(),
  };
  const v = instance(),
    initial = await v.create(password),
    updated = addManualFact(initial, 'basic.name', '并发时的新事实', null);
  await Promise.all([
    v.updateTasks((tasks) => [...tasks, task]),
    v.save(updated),
    v.updateTasks((tasks) =>
      tasks.map((t) => ({
        ...t,
        latest: {
          ...t.latest,
          status: 'DRAFT' as const,
          state_revision: 3,
          invalid_reason: 'PAGE_CHANGED',
        },
        invalid_reason: 'PAGE_CHANGED',
      })),
    ),
  ]);
  let actual = await v.readCurrent();
  expect(actual.facts[0]?.value).toBe('并发时的新事实');
  expect(actual.fill_tasks?.[0]?.latest.state_revision).toBe(3);
  await v.updateTasks(() => [task]);
  actual = await v.readCurrent();
  expect(actual.fill_tasks?.[0]?.latest.invalid_reason).toBe('PAGE_CHANGED');
  expect(actual.facts[0]?.value).toBe('并发时的新事实');
});
it('同窗保存期间排队的读取不误报跨窗口冲突，锁定会取消旧队列', async () => {
  const v = instance(),
    initial = await v.create(password),
    updated = addManualFact(initial, 'basic.name', '保存后读取', null);
  const jobs = [
    v.save(updated),
    ...Array.from({ length: 5 }, () => v.readCurrent()),
  ];
  const results = await Promise.all(jobs);
  expect(results.every((p) => p.facts[0]?.value === '保存后读取')).toBe(true);
  const pending = v.updateTasks((tasks) => tasks);
  v.lock();
  await expect(pending).rejects.toThrow('已锁定');
});

it('JD 与分析加密保存，事实编辑保留最新岗位，旧备份仍可恢复', async () => {
  const { manualJob, putCareerJob, emptyCareer } = await import(
    '@formpilot/domain'
  );
  const { jobSource } = await import('../../../tests/fixtures/career');
  const v = instance(),
    restored = instance(),
    legacy = instance();
  const original = await v.create(password);
  const oldBackup = await v.backup();
  await legacy.restore(oldBackup, password);
  expect((await legacy.unlock(password)).career).toBeUndefined();
  const doc = await manualJob(
    jobSource('PRIVATE_JD_SENTINEL 本科及以上学历。'),
  );
  await v.updateCareer((c) => putCareerJob(c, doc));
  await v.save(addManualFact(original, 'basic.name', '合成资料', null));
  expect((await v.readCurrent()).career?.jobs[0]?.job_id).toBe(doc.job_id);
  const backup = await v.backup();
  expect(backup).not.toContain('PRIVATE_JD_SENTINEL');
  await restored.restore(backup, password);
  expect(
    (await restored.unlock(password)).career?.jobs[0]?.source.text,
  ).toContain('PRIVATE_JD_SENTINEL');
  await v.updateCareer(() => emptyCareer());
  expect((await v.readCurrent()).career?.revision).toBe(2);
  v.lock();
  await expect(v.updateCareer((c) => c)).rejects.toThrow();
});

it('岗位简历加密备份恢复与事实/任务更新串行保存，不回退审核状态', async () => {
  const {
    createResumeVariant,
    putResumeVariant,
    reviseResumeVariant,
    putCareerJob,
  } = await import('@formpilot/domain');
  const { qualifiedProfile, reviewedJob } = await import(
    '../../../tests/fixtures/career'
  );
  const v = instance(),
    restored = instance();
  const initial = await v.create(password);
  const profile = { ...qualifiedProfile(), workspace_id: initial.workspace_id };
  await v.save(profile);
  const job = await reviewedJob([
    { kind: 'skill', quote: '熟练掌握Java。', term: 'Java' },
  ]);
  await v.updateCareer((c) => putCareerJob(c, job));
  const draft = await createResumeVariant(
    job,
    await v.readCurrent(),
    'PRIVATE_RESUME_SENTINEL',
  );
  await v.updateCareer((c) => putResumeVariant(c, draft));
  const olderProfile = await v.readCurrent();
  await v.updateCareer((c, p) =>
    putResumeVariant(
      c,
      reviseResumeVariant(c.resumes![0]!, { approve: true }, c.jobs[0]!, p),
      draft.revision,
    ),
  );
  await v.save(
    addManualFact(olderProfile, 'basic.name', '稍后新增的资料', null),
  );
  await v.updateTasks((tasks) => tasks);
  expect((await v.readCurrent()).career?.resumes?.[0]?.status).toBe('approved');
  const backup = await v.backup();
  expect(backup).not.toContain('PRIVATE_RESUME_SENTINEL');
  await restored.restore(backup, password);
  const p = await restored.unlock(password);
  expect(p.career?.resumes?.[0]?.name).toBe('PRIVATE_RESUME_SENTINEL');
  expect(p.career?.resumes?.[0]?.history).toHaveLength(1);
  await expect(
    v.updateCareer((c) => {
      c.resumes![0]!.blocks[0]!.facts[0]!.value = '编造值';
      return c;
    }),
  ).rejects.toThrow('事实不一致');
  expect(
    (await v.readCurrent()).career?.resumes?.[0]?.blocks[0]?.facts[0]?.value,
  ).not.toBe('编造值');
});

it('审核操作读取同一写队列中的最新资料版本，不批准并发过期简历', async () => {
  const {
    createResumeVariant,
    putResumeVariant,
    reviseResumeVariant,
    putCareerJob,
  } = await import('@formpilot/domain');
  const { qualifiedProfile, reviewedJob } = await import(
    '../../../tests/fixtures/career'
  );
  const v = instance(),
    initial = await v.create(password);
  await v.save({ ...qualifiedProfile(), workspace_id: initial.workspace_id });
  const job = await reviewedJob([
    { kind: 'education', quote: '本科及以上学历。' },
  ]);
  await v.updateCareer((c) => putCareerJob(c, job));
  const original = await v.readCurrent(),
    draft = await createResumeVariant(job, original, '并发审核');
  await v.updateCareer((c) => putResumeVariant(c, draft));
  const factUpdate = v.save(
    addManualFact(await v.readCurrent(), 'basic.name', '新资料', null),
  );
  const approval = v.updateCareer((c, p) =>
    putResumeVariant(
      c,
      reviseResumeVariant(c.resumes![0]!, { approve: true }, c.jobs[0]!, p),
      draft.revision,
    ),
  );
  await factUpdate;
  await expect(approval).rejects.toThrow('岗位或资料已变化');
  expect((await v.readCurrent()).career?.resumes?.[0]?.status).toBe('draft');
});

it('开放题及恢复检查点加密保存，事实编辑保留答案且审核读取最新资料', async () => {
  const { answerFixture, answerSelection } = await import(
    '../../../tests/fixtures/answer'
  );
  const {
    validateAnswerModel,
    acceptAnswer,
    putAnswer,
    putCareerJob,
    reviseAnswer,
  } = await import('@formpilot/domain');
  const { hashJson } = await import('@formpilot/contracts');
  const v = instance(),
    restored = instance(),
    initial = await v.create(password),
    f = await answerFixture();
  const profile = { ...f.profile, workspace_id: initial.workspace_id };
  await v.save(profile);
  await v.updateCareer((c) => putCareerJob(c, f.job));
  const request = {
    schema_version: 1 as const,
    client_request_id: crypto.randomUUID(),
    input: f.input,
    consent: {
      granted: true as const,
      purpose: 'answer_generate' as const,
      provider: 'test',
      model: 'test',
      policy_url: 'https://example.test',
      payload_hash: await hashJson(f.input),
      granted_at: Date.now(),
    },
  };
  await v.updateCareer((c) => ({
    ...c,
    answer_pending: [
      { request, facts: f.facts, api_job_id: null, started_at: Date.now() },
    ],
  }));
  const backup = await v.backup();
  expect(backup).not.toContain('未负责数据库优化');
  expect(backup).not.toContain('描述一次项目经历');
  await restored.restore(backup, password);
  expect(
    (await restored.unlock(password)).career?.answer_pending?.[0]?.request.input
      .question,
  ).toBe(f.input.question);
  const result = await validateAnswerModel(f.input, answerSelection(f.input), {
    provider: 'test',
    model: 'test',
    usage: { input_tokens: 1, output_tokens: 1 },
    duration_ms: 0,
  });
  const draft = await acceptAnswer(f.input, f.facts, result, request.consent);
  await v.updateCareer((c) => ({ ...putAnswer(c, draft), answer_pending: [] }));
  await v.updateCareer((c, p) =>
    putAnswer(
      c,
      reviseAnswer(
        c.answers![0]!,
        { text: draft.text + '\n本人核实的回答。' },
        c.jobs[0]!,
        p,
      ),
      draft.revision,
    ),
  );
  const old = await v.readCurrent();
  await v.save(addManualFact(old, 'basic.name', '新输入资料', null));
  await expect(
    v.updateCareer((c, p) =>
      putAnswer(
        c,
        reviseAnswer(c.answers![0]!, { approve: true }, c.jobs[0]!, p),
        c.answers![0]!.revision,
      ),
    ),
  ).rejects.toThrow('资料已变化');
  expect((await v.readCurrent()).career?.answers?.[0]?.text).toContain(
    '本人核实',
  );
  await expect(
    v.updateCareer((c) => {
      c.answers![0]!.facts[0]!.value = '篡改事实';
      return c;
    }),
  ).rejects.toThrow('不一致');
});
