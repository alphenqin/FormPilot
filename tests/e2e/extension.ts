import { chromium, type Page } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
export const vaultPassword = 'test-vault-passphrase';
export async function openExtension(directory?: string) {
  const dir = directory ?? (await mkdtemp(join(tmpdir(), 'formpilot-m1-')));
  const path = resolve('apps/extension/dist');
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
    acceptDownloads: true,
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  return { context, page, id, dir };
}
export async function createVault(page: Page) {
  await page.getByLabel('资料库口令', { exact: true }).fill(vaultPassword);
  await page.getByLabel('再次输入口令').fill(vaultPassword);
  await page.getByRole('button', { name: '建立资料库', exact: true }).click();
  await page.getByRole('button', { name: '锁定资料库', exact: true }).waitFor();
}
export async function unlockVault(page: Page, password = vaultPassword) {
  await page.getByLabel('资料库口令', { exact: true }).fill(password);
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await page.getByRole('button', { name: '锁定资料库', exact: true }).waitFor();
}
