import { blocksFromPages, type Document } from '@formpilot/domain';
import { toBase64 } from '@formpilot/local-store';
export async function createDocument(
  name: string,
  mime: string,
  bytes: Uint8Array<ArrayBuffer>,
  pages: { page: number | null; text: string }[],
): Promise<Document> {
  const document_id = crypto.randomUUID();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return {
    document_id,
    document_revision: 1,
    name,
    mime,
    content_hash: hash,
    created_at: new Date().toISOString(),
    blocks: blocksFromPages(document_id, pages),
    original_base64: toBase64(bytes),
    status: 'imported',
    error: null,
    job_id: null,
    client_request_id: null,
    consent_hash: null,
    parse_consent: null,
  };
}
export async function importText(text: string) {
  return createDocument(
    '手动输入.txt',
    'text/plain',
    new TextEncoder().encode(text),
    [{ page: null, text }],
  );
}
export async function importFile(file: File): Promise<Document> {
  if (file.size > 10 * 1024 * 1024) throw new Error('文件不能超过 10 MB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.txt$/i.test(file.name)) {
    if (bytes.length > 1000000) throw new Error('TXT 不能超过 1 MB');
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('TXT 请使用 UTF-8 编码');
    }
    return createDocument(file.name, 'text/plain', bytes, [
      { page: null, text },
    ]);
  }
  if (
    !/\.pdf$/i.test(file.name) ||
    new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-'
  )
    throw new Error('只支持有效 PDF 或 UTF-8 TXT');
  const pdfjs = await import('pdfjs-dist');
  const { default: workerUrl } = await import(
    'pdfjs-dist/build/pdf.worker.min.mjs?url'
  );
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    useWasm: false,
    useSystemFonts: true,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 100) throw new Error('PDF 不能超过 100 页');
    const pages: { page: number; text: string }[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) =>
          'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '',
        )
        .join('');
      pages.push({ page: i, text });
      page.cleanup();
    }
    return await createDocument(file.name, 'application/pdf', bytes, pages);
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException')
      throw new Error('PDF 受密码保护，请先解密或改用 TXT');
    throw error;
  } finally {
    await task.destroy();
  }
}
