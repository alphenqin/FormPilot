import { useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
let root: Root | null = null;
function ControlledForm({ mode }: { mode: 'accept' | 'reset' }) {
  const [email, setEmail] = useState('');
  useEffect(() => {
    if (mode !== 'reset' || !email) return;
    const timer = setTimeout(() => setEmail(''), 130);
    return () => clearTimeout(timer);
  }, [email, mode]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        window.submits++;
      }}
    >
      <label>
        React 受控邮箱
        <input
          id="react-email"
          name="react-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <button type="submit">提交（禁止）</button>
    </form>
  );
}
export function mountReactForm(mode: 'accept' | 'reset') {
  if (!root) {
    const container = document.createElement('div');
    container.id = 'react-fixture';
    document.body.append(container);
    root = createRoot(container);
  }
  root.render(<ControlledForm mode={mode} />);
}
