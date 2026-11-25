// 只用固定虚构资料调用一次真实模型，不读取真实资料库。
import { createApp } from '../apps/api/src/app';
import { getModelProvider } from '@formpilot/ai';
import { hashJson, planConsentPayload } from '@formpilot/contracts';
import { planningRequest, field, fact } from '../tests/fixtures/planning';
const provider = getModelProvider(process.env),
  token = crypto.randomUUID();
const app = createApp({ provider, apiToken: token });
try {
  const session = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: { authorization: 'Bearer ' + token },
    payload: { workspace_id: 'synthetic-smoke-workspace' },
  });
  const r = await planningRequest(
    [field('姓名'), field('现居城市', 'f2'), field('意向城市', 'f3')],
    [
      fact('basic.name', '虚构模型测试同学'),
      fact('basic.current_city', '杭州'),
    ],
  );
  r.consent = {
    ...r.consent,
    provider: provider.name,
    model: provider.model,
    policy_url: provider.policyURL,
    payload_hash: await hashJson(planConsentPayload(r)),
    granted_at: Date.now(),
  };
  const response = await app.inject({
    method: 'POST',
    url: '/v1/fill/plan',
    headers: {
      authorization: 'Bearer ' + session.json().data.session_token,
      'idempotency-key': r.client_request_id,
    },
    payload: r,
  });
  const data = response.json().data;
  if (
    response.statusCode !== 200 ||
    data.degraded ||
    data.field_decisions
      .map((d: { decision: string }) => d.decision)
      .join(',') !== 'fill,fill,ask'
  )
    throw new Error(
      '真实计划模型验证失败：' + (data?.degraded_reason ?? response.statusCode),
    );
  process.stdout.write(
    JSON.stringify({
      measurement: 'synthetic-live-plan',
      provider: provider.name,
      model: provider.model,
      fields: 3,
      decisions: ['fill', 'fill', 'ask'],
      duration_ms: data.duration_ms,
      usage: data.usage,
      degraded: data.degraded,
    }) + '\n',
  );
} finally {
  await app.close();
}
