import { parseEnv } from 'node:util';
let localEnv = {};
try {
  localEnv = parseEnv(await readFile('.env', 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const configuredSecrets = [
  'FORMPILOT_MODEL_API_KEY',
  'FORMPILOT_API_TOKEN',
  'FORMPILOT_DATA_KEY',
]
  .flatMap((key) => [localEnv[key], process.env[key]])
  .filter((value) => typeof value === 'string' && value.length >= 12);
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
async function verify(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await verify(path);
    else {
      const content = await readFile(path, 'utf8');
      for (const secret of [
        ...configuredSecrets,
        'FORMPILOT_API_TOKEN',
        'FORMPILOT_DATA_KEY',
        'FORMPILOT_MODEL_API_KEY',
        'OPENAI_API_KEY',
        'GEMINI_API_KEY',
        'ANTHROPIC_API_KEY',
        'M0_SECRET_LEAK_SENTINEL',
      ]) {
        if (content.includes(secret))
          throw new Error(`客户端产物含服务端配置标记: ${path}`);
      }
    }
  }
}
await verify('apps/web/dist');
await verify('apps/extension/dist');
const manifest = JSON.parse(
  await readFile('apps/extension/dist/manifest.json', 'utf8'),
);
if (
  manifest.content_scripts ||
  JSON.stringify(manifest.host_permissions) !==
    JSON.stringify(['http://127.0.0.1/*']) ||
  JSON.stringify([...manifest.permissions].sort()) !==
    JSON.stringify(['activeTab', 'scripting', 'storage', 'sidePanel'].sort())
)
  throw new Error('扩展权限超出当前最小权限范围');
process.stdout.write('客户端产物密钥标记与最小权限检查通过\n');
