import {
  hashJson,
  planConsentPayload,
  type FillPlanRequest,
  type ScannedField,
  type PlanFact,
  type FactPath,
} from '@formpilot/contracts';
export function field(
  label = '姓名',
  id = 'field-1',
  change: Partial<ScannedField> = {},
): ScannedField {
  return {
    field_id: id,
    locator_ref: 'locator-' + id,
    group_id: 'group-1',
    form_id: 'form-1',
    label,
    label_source: 'label',
    manual_label: null,
    description: '',
    name: '',
    html_id: '',
    placeholder: '',
    control_type: 'text',
    required: true,
    visible: true,
    enabled: true,
    read_only: false,
    supported: true,
    manual_reason: null,
    current_value: '',
    options: [],
    option_count: 0,
    constraints: {
      min: null,
      max: null,
      step: null,
      pattern: null,
      min_length: null,
      max_length: 100,
      accept: null,
      multiple: false,
    },
    ...change,
  };
}
export function fact(
  path: FactPath = 'basic.name',
  value: PlanFact['value'] = 'PLAN_PRIVATE_SENTINEL',
  entity = 'basic-1',
): PlanFact {
  return {
    fact_id: crypto.randomUUID(),
    fact_revision: 1,
    profile_revision: 1,
    category: path.split('.')[0]!,
    path,
    value,
    entity_id: entity,
    confirmation: 'confirmed',
    source_type: 'user',
    evidence_ids: [],
    document_id: null,
  };
}
export async function planningRequest(
  fields = [field()],
  facts = [fact()],
): Promise<FillPlanRequest> {
  const entities = [
    ...new Map(
      facts.map((f) => [
        f.entity_id,
        { entity_id: f.entity_id, category: f.category, label: f.entity_id },
      ]),
    ).values(),
  ];
  const input = {
    schema_version: 1 as const,
    client_request_id: crypto.randomUUID(),
    task_id: 'task-1',
    expected_plan_revision: 0,
    profile_revision: 1,
    form_snapshot: {
      protocol_version: '1' as const,
      task_id: 'task-1',
      tab_id: 1,
      frame_id: 0 as const,
      page_instance_id: 'page-1',
      form_snapshot_id: 'snapshot-1',
      dom_fingerprint: 'a'.repeat(64),
      snapshot_revision: 1,
      origin: 'https://example.test',
      route: '/apply',
      adapter_version: 'native-1',
      site_id: 'generic',
      captured_at: Date.now(),
      duration_ms: 1,
      complete: true,
      fields,
      groups: [
        {
          group_id: 'group-1',
          form_id: 'form-1',
          label: '基本信息',
          parent_group_id: null,
        },
      ],
      warnings: [],
      excluded: { hidden: 0, sensitive: 0, actions: 0 },
    },
    confirmed_facts: facts,
    entities,
    evidences: [],
    task_answers: [],
  };
  return {
    ...input,
    consent: {
      granted: true,
      purpose: 'fill_plan',
      provider: 'deepseek',
      model: 'test-model',
      policy_url: 'https://example.test/policy',
      payload_hash: await hashJson(
        planConsentPayload(input as Omit<FillPlanRequest, 'consent'>),
      ),
      granted_at: Date.now(),
    },
  } as FillPlanRequest;
}
