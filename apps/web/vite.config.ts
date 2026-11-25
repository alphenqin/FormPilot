import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile } from 'node:fs/promises';
// 仅开发服务器开放固定测试模板；构建产物不包含这些路由或私有文件服务。
const fixtureNames = new Set([
  'basic.html',
  'career.html',
  'dynamic.html',
  'accessibility.html',
  'embedded.html',
  'execution.html',
  'standard-basic.html',
  'standard-education.html',
  'standard-internships.html',
]);
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'm2-local-fixtures',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = request.url?.split('?')[0] ?? '';
          if (!path.startsWith('/m2-fixtures/')) return next();
          const name = path.slice('/m2-fixtures/'.length);
          if (!fixtureNames.has(name)) {
            response.statusCode = 404;
            response.end('Not found');
            return;
          }
          void readFile(
            new URL('../../tests/fixtures/forms/' + name, import.meta.url),
            'utf8',
          )
            .then((html) => {
              response.setHeader('Content-Type', 'text/html; charset=utf-8');
              response.setHeader('Cache-Control', 'no-store');
              response.end(html);
            })
            .catch(() => {
              response.statusCode = 500;
              response.end('Fixture unavailable');
            });
        });
      },
    },
  ],
});
