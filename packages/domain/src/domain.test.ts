import { it, expect } from 'vitest';
import {
  syntheticProfile,
  syntheticDocument,
  nameExtraction,
} from '../../../tests/fixtures/resumes/synthetic';
import {
  importExtraction,
  currentFacts,
  confirmedFacts,
  reviseFact,
  validDate,
  anomalies,
  validateCandidates,
  factConflicts,
  addManualFact,
  emptyProfile,
  mergeEntities,
} from './index';
it('候选全部待确认，确认及编辑形成不可变历史，修改值标记用户来源', () => {
  let p = syntheticProfile();
  const d = p.documents[0]!;
  p = importExtraction(p, d.document_id, nameExtraction(d));
  const id = p.facts[0]!.fact_id;
  expect(confirmedFacts(p)).toHaveLength(0);
  p = reviseFact(p, id, { confirmation: 'confirmed' });
  expect(confirmedFacts(p)).toHaveLength(1);
  p = reviseFact(p, id, { value: '手动修改' });
  expect(currentFacts(p)[0]).toMatchObject({
    source_type: 'user',
    confirmation: 'pending',
    fact_revision: 3,
  });
  expect(p.facts[0]!.value).toBe('测试同学');
  expect(p.evidences[0]!.quote).toBe('姓名：测试同学');
  expect(confirmedFacts(p)).toHaveLength(0);
});
it('拒绝不存在的块、虚构证据和值、未知路径以及分类错配', () => {
  const d = syntheticDocument();
  const valid = nameExtraction(d).candidates[0]!;
  for (const change of [
    { block_id: 'fake' },
    { quote: '根本不存在' },
    { value: '真实原文没有此人' },
    { path: 'basic.password' },
    { category: 'education' },
  ])
    expect(() =>
      validateCandidates(d, { candidates: [{ ...valid, ...change }] }),
    ).toThrow();
});
it('日期保留精度，不能将范围中的数字拼成具体日', () => {
  const d = syntheticDocument('2020年9月 至 2024年6月');
  const c = {
    category: 'education',
    path: 'education.start_date',
    value: { value: '2020-09', precision: 'month' },
    entity_key: '示例大学',
    block_id: d.blocks[0]!.block_id,
    quote: d.blocks[0]!.text,
  };
  expect(validateCandidates(d, { candidates: [c] })).toHaveLength(1);
  expect(() =>
    validateCandidates(d, {
      candidates: [{ ...c, value: { value: '2020-09-06', precision: 'day' } }],
    }),
  ).toThrow();
  expect(validDate({ value: '2024-02-30', precision: 'day' })).toBe(false);
  expect(validDate({ value: '2020-09', precision: 'month' })).toBe(true);
});
it('多简历冲突必须显式拒绝旧值后确认，不静默替换', () => {
  let p = syntheticProfile();
  p = importExtraction(
    p,
    p.documents[0]!.document_id,
    nameExtraction(p.documents[0]!),
  );
  p = reviseFact(p, p.facts[0]!.fact_id, { confirmation: 'confirmed' });
  const d = syntheticDocument('姓名：另一同学');
  p.documents.push(d);
  p = importExtraction(p, d.document_id, nameExtraction(d, '另一同学'));
  const newer = currentFacts(p).at(-1)!;
  expect(factConflicts(p, newer)).toHaveLength(1);
  expect(() =>
    reviseFact(p, newer.fact_id, { confirmation: 'confirmed' }),
  ).toThrow();
  p = reviseFact(p, p.facts[0]!.fact_id, { confirmation: 'rejected' });
  p = reviseFact(p, newer.fact_id, { confirmation: 'confirmed' });
  expect(confirmedFacts(p).map((f) => f.value)).toEqual(['另一同学']);
});
it('不同经历不能混合，用户整组映射后重新确认并保留历史', () => {
  let p = emptyProfile();
  p = addManualFact(p, 'work.company', '公司甲', null);
  p = addManualFact(p, 'work.company', '公司乙', null);
  expect(p.entities).toHaveLength(2);
  const [a, b] = p.entities;
  p = mergeEntities(p, b!.entity_id, a!.entity_id);
  expect(
    currentFacts(p).every(
      (f) => f.entity_id === a!.entity_id && f.confirmation === 'pending',
    ),
  ).toBe(true);
  expect(p.facts).toHaveLength(3);
  expect(() =>
    reviseFact(p, p.facts[0]!.fact_id, { entity_id: 'unknown' }),
  ).toThrow();
});
it('时间倒置提示，跨实体合理重叠不判错', () => {
  let p = emptyProfile();
  p = addManualFact(
    p,
    'project.start_date',
    { value: '2025-06', precision: 'month' },
    null,
  );
  const id = p.entities[0]!.entity_id;
  p = addManualFact(
    p,
    'project.end_date',
    { value: '2024-06', precision: 'month' },
    id,
  );
  expect(anomalies(p)).toHaveLength(1);
  p = reviseFact(p, currentFacts(p)[1]!.fact_id, {
    value: { value: '2026', precision: 'year' },
  });
  p = addManualFact(
    p,
    'work.start_date',
    { value: '2025-06', precision: 'month' },
    null,
  );
  expect(anomalies(p)).toHaveLength(0);
});
it('同一文档不能重复创建事实版本', () => {
  let p = syntheticProfile();
  const d = p.documents[0]!;
  p = importExtraction(p, d.document_id, nameExtraction(d));
  expect(() => importExtraction(p, d.document_id, nameExtraction(d))).toThrow();
});
