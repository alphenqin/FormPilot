import { ScanPanel } from './scanner/ScanPanel';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { parseHealth } from '@formpilot/contracts';
import './ui.css';
import { Workspace } from './workspace/Workspace';
function App() {
  const [status, setStatus] = useState('尚未检测');
  const [pairCode, setPairCode] = useState('');
  async function check() {
    setStatus('检测中…');
    try {
      const response: unknown = await chrome.runtime.sendMessage({
        protocol_version: '1',
        request_id: crypto.randomUUID(),
        task_id: null,
        method: 'health',
      });
      parseHealth(response);
      setStatus('API 已连接');
    } catch {
      setStatus('API 未连接，请启动本地服务');
    }
  }
  async function pair() {
    try {
      const code = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      await chrome.storage.session.set({
        pairing: { code, expires: Date.now() + 120000 },
      });
      setPairCode(code);
    } catch {
      setStatus('无法生成配对码，请重试');
    }
  }
  return (
    <main>
      <span className="badge">M2 · 表单扫描</span>
      <h1>FormPilot</h1>
      <p>连接本地服务，准备个人求职工作空间。</p>
      <button onClick={() => void chrome.runtime.openOptionsPage()}>
        打开个人资料库
      </button>
      <ScanPanel compact={location.pathname === '/popup.html'} />
      <section>
        <h2>服务状态</h2>
        <p role="status">{status}</p>
        <button onClick={() => void check()}>检测 API 连接</button>
      </section>
      <section>
        <h2>连接管理页面</h2>
        <p>
          仅允许
          http://localhost:3000。配对码两分钟内有效，使用一次后失效，会话最长 30
          分钟。
        </p>
        <label>
          扩展 ID
          <input readOnly value={chrome.runtime.id} />
        </label>
        <button onClick={() => void pair()}>生成一次性配对码</button>
        {pairCode && (
          <label>
            配对码
            <input readOnly value={pairCode} />
          </label>
        )}
      </section>
      <p className="muted">
        资料库和原生表单扫描已开放；填写计划与自动填写将在后续阶段实现。
      </p>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  location.pathname === '/options.html' ? <Workspace /> : <App />,
);
