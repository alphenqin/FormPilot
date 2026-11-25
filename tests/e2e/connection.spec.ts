import { test as base, expect, chromium } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
async function stopApi(api: ChildProcess) {
  if (api.exitCode === null && !api.killed) {
    const stopped = once(api, 'exit');
    api.kill('SIGTERM');
    await stopped;
  }
}
const test = base.extend<{ apiProcess: ChildProcess }>({
  apiProcess: async ({ browserName }, use) => {
    if (browserName !== 'chromium') throw new Error('扩展验收仅使用 Chromium');
    const api = spawn(process.execPath, ['apps/api/dist/server.js'], {
      env: {
        ...process.env,
        FORMPILOT_HOST: '127.0.0.1',
        FORMPILOT_PORT: '4318',
      },
      stdio: 'ignore',
    });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (api.exitCode !== null)
          throw new Error('构建后的 API 启动失败，请检查 4318 端口');
        try {
          const response = await fetch('http://127.0.0.1:4318/health', {
            signal: AbortSignal.timeout(500),
          });
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          /* 等待临时 API 就绪 */
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!ready) throw new Error('构建后的 API 未就绪');
      await use(api);
    } finally {
      await stopApi(api);
    }
  },
});
test('真实扩展加载、网页配对、会话校验与扩展到 API', async ({ apiProcess }) => {
  const directory = await mkdtemp(join(tmpdir(), 'formpilot-e2e-'));
  const extension = resolve('apps/extension/dist');
  const context = await chromium.launchPersistentContext(directory, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await expect(
      popup.getByRole('heading', { name: 'FormPilot', exact: true }),
    ).toBeVisible();
    await popup.getByRole('button', { name: '检测 API 连接' }).click();
    await expect(popup.getByRole('status')).toHaveText('API 已连接');
    for (const path of ['options', 'sidepanel']) {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${id}/${path}.html`);
      await expect(
        page.getByRole('heading', {
          name: path === 'options' ? '建立加密资料库' : 'FormPilot',
          exact: true,
        }),
      ).toBeVisible();
      await page.close();
    }
    const web = await context.newPage();
    await web.goto('http://localhost:3000');
    await web.getByLabel('扩展 ID').fill(id);
    await web.getByLabel('一次性配对码').fill('a'.repeat(32));
    await web.getByRole('button', { name: '配对并检测连接' }).click();
    await expect(web.getByRole('status')).toContainText('有效的一次性配对码');
    await popup.getByRole('button', { name: '生成一次性配对码' }).click();
    const code = await popup.getByLabel('配对码', { exact: true }).inputValue();
    await web.getByLabel('一次性配对码').fill(code);
    await web.getByRole('button', { name: '配对并检测连接' }).click();
    await expect(web.getByRole('status')).toHaveText('扩展已连接');
    await expect(web.getByTestId('api-status')).toContainText('API 已连接');
    await web.getByRole('button', { name: '重新检测' }).click();
    await expect(web.getByRole('status')).toHaveText('扩展已连接');
    await expect(web.getByTestId('api-status')).toContainText('API 已连接');
    await web.screenshot({
      path: 'test-results/m0-web.png',
      fullPage: true,
    });
    const result = await web.evaluate(
      async ({ id, code }) => {
        const send = (message: Record<string, unknown>) =>
          new Promise<{ error: { code: string } }>((resolve) =>
            chrome.runtime.sendMessage(
              id,
              {
                protocol_version: '1',
                request_id: 'test',
                task_id: null,
                ...message,
              },
              resolve,
            ),
          );
        return {
          replay: await send({ method: 'pair', pairing_code: code }),
          badToken: await send({
            method: 'ping',
            session_token: '0'.repeat(64),
          }),
          blockedMethod: await send({ method: 'health' }),
          unknownMethod: await send({ method: 'execute' }),
        };
      },
      { id, code },
    );
    expect(result.replay.error.code).toBe('CONSENT_REQUIRED');
    expect(result.badToken.error.code).toBe('UNAUTHORIZED');
    expect(result.blockedMethod.error.code).toBe('SCOPE_DENIED');
    expect(result.unknownMethod.error.code).toBe('INVALID_REQUEST');
    const frameElement = await web.evaluateHandle(() => {
      const frame = document.createElement('iframe');
      frame.src = 'http://localhost:3000';
      document.body.append(frame);
      return frame;
    });
    const iframe = await frameElement.asElement()!.contentFrame();
    await iframe!.waitForLoadState();
    const iframeResult = await iframe!.evaluate(
      async (id) =>
        new Promise<{ error: { code: string } }>((resolve) =>
          chrome.runtime.sendMessage(
            id,
            {
              protocol_version: '1',
              request_id: 'iframe-test',
              task_id: null,
              method: 'ping',
              session_token: '0'.repeat(64),
            },
            resolve,
          ),
        ),
      id,
    );
    expect(iframeResult.error.code).toBe('SCOPE_DENIED');
    // 会话期限由扩展本地会话存储判定。
    await worker.evaluate(async () => {
      const entries = await chrome.storage.session.get(null);
      for (const [key, value] of Object.entries(entries)) {
        if (key.startsWith('session_'))
          await chrome.storage.session.set({
            [key]: { ...(value as Record<string, unknown>), expires: 0 },
          });
      }
    });
    await web.getByRole('button', { name: '重新检测' }).click();
    await expect(web.getByRole('status')).toHaveText('连接已失效，请重新配对');
    await web.reload();
    await expect(web.getByRole('status')).toHaveText('尚未连接');
    // 无效/未实现 API 不能被扩展报为健康。
    await worker.evaluate(async () => {
      await chrome.storage.session.remove('pairing');
    });
    await stopApi(apiProcess);
    await popup.getByRole('button', { name: '检测 API 连接' }).click();
    await expect(popup.getByRole('status')).toHaveText(
      'API 未连接，请启动本地服务',
    );
    await popup.screenshot({
      path: 'test-results/m0-extension.png',
      fullPage: true,
    });
    const manifest = JSON.parse(
      await readFile(resolve(extension, 'manifest.json'), 'utf8'),
    );
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.host_permissions).not.toContain('<all_urls>');
  } finally {
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('未加载扩展时显示真实连接失败', async ({ page }) => {
  await page.goto('http://localhost:3000');
  await page.getByLabel('扩展 ID').fill('a'.repeat(32));
  await page.getByLabel('一次性配对码').fill('b'.repeat(32));
  await page.getByRole('button', { name: '配对并检测连接' }).click();
  await expect(page.getByRole('status')).not.toHaveText('扩展已连接');
  await expect(page.getByRole('status')).toContainText(/无法连接扩展|请使用/);
});
