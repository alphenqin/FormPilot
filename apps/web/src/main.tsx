import { parseBridgeResponse, type BridgeResponse } from '@formpilot/contracts';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import './style.css';
function send(
  id: string,
  message: Record<string, unknown>,
): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendMessage)
      return reject(
        new Error(
          '请使用已加载 FormPilot 扩展的 Chromium 浏览器，并通过 localhost:3000 访问',
        ),
      );
    const timer = setTimeout(
      () => reject(new Error('扩展响应超时，请检查扩展 ID')),
      4000,
    );
    const requestId = crypto.randomUUID();
    chrome.runtime.sendMessage(
      id,
      {
        protocol_version: '1',
        request_id: requestId,
        task_id: null,
        ...message,
      },
      (raw: unknown) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError)
          return reject(new Error('无法连接扩展，请检查 ID 和加载状态'));
        try {
          const response = parseBridgeResponse(raw, requestId);
          if (response.error) return reject(new Error(response.error.message));
          resolve(response);
        } catch (error) {
          reject(error);
        }
      },
    );
  });
}
function App() {
  const [id, setId] = useState('');
  const [code, setCode] = useState('');
  const [status, setStatus] = useState('尚未连接');
  const [apiStatus, setApiStatus] = useState('等待扩展连接');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  async function connect() {
    setBusy(true);
    setToken('');
    setApiStatus('等待检测');
    try {
      if (!/^[a-p]{32}$/.test(id) || !/^[a-f0-9]{32}$/.test(code))
        throw new Error('请填写有效的扩展 ID 和配对码');
      const result = await send(id, { method: 'pair', pairing_code: code });
      const session = result.data?.session_token;
      if (!session) throw new Error('配对响应无效');
      setToken(session);
      setCode('');
      const ping = await send(id, { method: 'ping', session_token: session });
      if (ping.data?.pong !== true) throw new Error('连接检测失败');
      setStatus('扩展已连接');
      setApiStatus(
        ping.data.api_connected ? 'API 已连接' : 'API 未连接，请启动本地服务',
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '连接失败');
    } finally {
      setBusy(false);
    }
  }
  async function ping() {
    try {
      const result = await send(id, { method: 'ping', session_token: token });
      if (result.data?.pong !== true) throw new Error('响应无效');
      setStatus('扩展已连接');
      setApiStatus(
        result.data.api_connected ? 'API 已连接' : 'API 未连接，请启动本地服务',
      );
    } catch {
      setToken('');
      setStatus('连接已失效，请重新配对');
      setApiStatus('等待扩展连接');
    }
  }
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <span>F</span> FormPilot
        </div>
        <p>个人求职工作空间</p>
        <div className="nav">◉ 连接中心</div>
        <small>M2 · 表单扫描</small>
      </aside>
      <main>
        <header>
          <span>工作空间 / 连接中心</span>
          <span className="stage">开发预览</span>
        </header>
        <div className="content">
          <div className="eyebrow">开始使用 FORMPILOT</div>
          <h1>连接你的求职助手</h1>
          <p className="intro">
            通过浏览器扩展连接本地服务，为后续的简历管理与网申填写做好准备。
          </p>
          <section>
            <div className="section-title">
              <h2>浏览器扩展</h2>
              <span className="status" role="status">
                {status}
              </span>
            </div>
            <p>加载扩展后，打开 FormPilot 弹窗，生成一次性配对码。</p>
            <p data-testid="api-status">本地服务：{apiStatus}</p>
            <label htmlFor="extension-id">扩展 ID</label>
            <input
              id="extension-id"
              value={id}
              placeholder="从扩展弹窗复制 ID"
              onChange={(e) => {
                setId(e.target.value.trim());
                setToken('');
                setStatus('尚未连接');
                setApiStatus('等待扩展连接');
              }}
            />
            <label htmlFor="pair-code">一次性配对码</label>
            <input
              id="pair-code"
              value={code}
              placeholder="输入两分钟内有效的配对码"
              onChange={(e) => setCode(e.target.value.trim())}
            />
            <div className="actions">
              <button disabled={busy} onClick={() => void connect()}>
                {busy ? '正在连接…' : '配对并检测连接'}
              </button>
              {token && (
                <button className="secondary" onClick={() => void ping()}>
                  重新检测
                </button>
              )}
            </div>
          </section>
          <section className="roadmap">
            <h2>接下来</h2>
            <p>
              资料库与原生表单扫描已在扩展中开放。请从扩展启动扫描并核对字段；填写计划将在后续阶段开放。
            </p>
            <div className="steps">
              <span>01 建立个人资料</span>
              <span>02 识别网页表单</span>
              <span>03 审核并填写</span>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
