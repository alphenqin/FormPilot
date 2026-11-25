/* global document, location */
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const targets = [
  { site: 'tencent', url: 'https://careers.tencent.com/' },
  { site: 'bytedance', url: 'https://jobs.bytedance.com/' },
  { site: 'xiaomi', url: 'https://hr.xiaomi.com/opportunities.html' },
];
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const results = [];
try {
  for (const target of targets) {
    const page = await browser.newPage();
    try {
      const response = await page.goto(target.url, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await page.waitForTimeout(1500);
      const inspected = await page.evaluate(() => ({
        title: document.title.slice(0, 100),
        origin: location.origin,
        path: location.pathname,
        forms: document.forms.length,
        native_controls: document.querySelectorAll(
          'input:not([type=hidden]):not([type=password]),textarea,select',
        ).length,
        custom_controls: document.querySelectorAll(
          '[role=combobox],[role=listbox],[contenteditable=true]',
        ).length,
        password_controls: document.querySelectorAll('input[type=password]')
          .length,
        iframes: document.querySelectorAll('iframe').length,
        login_entry_present: [...document.querySelectorAll('a,button')].some(
          (element) =>
            /登录|登入|sign in|log in/i.test(element.textContent ?? ''),
        ),
      }));
      const row = {
        ...target,
        status: response?.status() ?? null,
        ...inspected,
        application_form_verified: false,
      };
      results.push(row);
      process.stdout.write(JSON.stringify(row) + '\n');
    } catch {
      const row = {
        ...target,
        status: null,
        error: 'PUBLIC_ENTRY_UNAVAILABLE',
        application_form_verified: false,
      };
      results.push(row);
      process.stdout.write(JSON.stringify(row) + '\n');
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
await writeFile(
  '/tmp/formpilot-m2-public-sites.json',
  JSON.stringify(
    {
      checked_at: new Date().toISOString(),
      scope: 'public-entry-only-no-login-no-values-no-submission',
      results,
    },
    null,
    2,
  ) + '\n',
);
