import {
  blocksFromPages,
  type Document,
  emptyProfile,
} from '@formpilot/domain';
export const syntheticText =
  '姓名：测试同学\n邮箱：synthetic@example.test\n教育：示例大学，本科，2020年9月 至 2024年6月。';
export function syntheticDocument(text = syntheticText): Document {
  const document_id = crypto.randomUUID();
  return {
    document_id,
    document_revision: 1,
    name: 'synthetic.txt',
    mime: 'text/plain',
    content_hash: 'a'.repeat(64),
    created_at: new Date().toISOString(),
    blocks: blocksFromPages(document_id, [{ page: null, text }]),
    original_base64: btoa(unescape(encodeURIComponent(text))),
    status: 'imported',
    error: null,
    job_id: null,
    client_request_id: null,
    consent_hash: null,
    parse_consent: null,
  };
}
export function syntheticProfile(text = syntheticText) {
  const document = syntheticDocument(text);
  return { ...emptyProfile(), documents: [document] };
}
export function nameExtraction(document: Document, name = '测试同学') {
  return {
    candidates: [
      {
        category: 'basic',
        path: 'basic.name',
        value: name,
        entity_key: '基本信息',
        block_id: document.blocks[0]!.block_id,
        quote: '姓名：' + name,
      },
    ],
  };
}
