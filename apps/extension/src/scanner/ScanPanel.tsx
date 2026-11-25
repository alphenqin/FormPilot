import { useState, useEffect, useRef } from 'react';
import { Value } from '@sinclair/typebox/value';
import {
  ScanDataSchema,
  LocateResultSchema,
  snapshotRef,
  type ScanData,
  type ScannedField,
  type FormSnapshot,
} from '@formpilot/contracts';
import { safeRoute, siteProfile } from '@formpilot/browser-engine';
import './scanner.css';
interface TabChoice {
  id: number;
  label: string;
}
const warnings: Record<string, string> = {
  IFRAME_NOT_SCANNED: '嵌入页面未扫描，请在获得授权的独立页面中人工核对',
  SHADOW_DOM_NOT_SCANNED: '检测到 Shadow DOM，当前需要人工处理',
  SENSITIVE_FIELDS_EXCLUDED: '密码、验证码或其他敏感字段已排除',
  FIELD_LIMIT: '字段数量超过上限，扫描结果不完整',
  OPTIONS_LIMIT: '选项过多，需要人工处理',
  VALUE_LIMIT: '字段内容超过长度限制，需要人工处理',
  METADATA_LIMIT: '字段说明或约束过长，需要人工核对',
  DUPLICATE_HTML_ID: '页面存在重复字段标识，已标记人工核对',
  AMBIGUOUS_OPTIONS: '存在相同值的不同选项，需人工核对',
};
const reasons: Record<string, string> = {
  FILE_MANUAL: '附件请在网页中手动选择',
  CUSTOM_CONTROL: '自定义控件，需要人工处理',
  CONTROL_UNSUPPORTED: '此类控件暂不支持',
  DISABLED: '字段当前不可编辑',
  READ_ONLY: '只读字段',
  OPTIONS_LIMIT: '选项超过识别上限',
  VALUE_LIMIT: '内容过长',
  METADATA_LIMIT: '字段说明或约束过长',
  DUPLICATE_HTML_ID: '字段标识重复，需要人工核对',
  AMBIGUOUS_RADIO_GROUP: '单选项跨越不同经历组，请人工核对',
  AMBIGUOUS_OPTIONS: '不同选项使用了相同值',
};
function current(value: ScannedField['current_value']) {
  return value === null
    ? '未读取 / 未选择'
    : Array.isArray(value)
      ? value.join('、')
      : typeof value === 'boolean'
        ? value
          ? '已勾选'
          : '未勾选'
        : value || '空';
}
async function request(
  method: string,
  args: Record<string, unknown> = {},
  task_id: string | null = null,
) {
  const request_id = crypto.randomUUID();
  const response: unknown = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('扫描响应超时，请重新打开扩展')),
      6500,
    );
    chrome.runtime.sendMessage(
      { protocol_version: '1', request_id, task_id, method, ...args },
      (reply) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError)
          reject(new Error('扩展连接失效，请重新加载'));
        else resolve(reply);
      },
    );
  });
  if (
    !response ||
    typeof response !== 'object' ||
    !('request_id' in response) ||
    response.request_id !== request_id ||
    !('data' in response) ||
    !('error' in response)
  )
    throw new Error('扫描响应无效');
  const envelope = response as {
    data: unknown;
    error: { message?: string } | null;
  };
  if (envelope.error) throw new Error(envelope.error.message ?? '扫描不可用');
  if (
    !Value.Check(
      method === 'scan.locate' ? LocateResultSchema : ScanDataSchema,
      envelope.data,
    )
  )
    throw new Error('扫描结果未通过校验');
  return envelope.data;
}
function FieldCard({
  field,
  snapshot,
  busy,
  act,
}: {
  field: ScannedField;
  snapshot: FormSnapshot;
  busy: boolean;
  act: (method: string, extra: Record<string, unknown>) => void;
}) {
  const [label, setLabel] = useState(field.manual_label ?? '');
  const auto = field.label_source === 'unknown';
  return (
    <article className="scan-field" data-scan-field-id={field.field_id}>
      <div className="scan-field-heading">
        <strong>{field.manual_label || field.label}</strong>
        <span>{field.required ? '必填' : '选填'}</span>
      </div>
      <p className="scan-value">当前值：{current(field.current_value)}</p>
      <p className="scan-small">
        {field.control_type}
        {field.enabled ? '' : ' · 不可编辑'}
        {field.read_only ? ' · 只读' : ''}
      </p>
      {field.description && <p className="scan-small">{field.description}</p>}
      {(!field.supported || auto) && (
        <p className="scan-warning">
          {field.manual_reason
            ? (reasons[field.manual_reason] ?? '请人工核对')
            : '未识别明确标签，请补充标注'}
        </p>
      )}
      <button
        disabled={busy}
        onClick={() =>
          act('scan.locate', {
            ref: snapshotRef(snapshot),
            field_id: field.field_id,
          })
        }
      >
        定位到网页
      </button>
      <details>
        <summary>选项与填写约束</summary>
        {field.options.length > 0 && (
          <ul>
            {field.options.map((option, i) => (
              <li key={i}>
                {option.label || option.value}
                {option.disabled ? '（不可选）' : ''}
              </li>
            ))}
          </ul>
        )}
        <p className="scan-small">
          {field.constraints.min !== null
            ? '最小值 ' + field.constraints.min + '；'
            : ''}
          {field.constraints.max !== null
            ? '最大值 ' + field.constraints.max + '；'
            : ''}
          {field.constraints.max_length !== null
            ? '最多 ' + field.constraints.max_length + ' 字；'
            : ''}
          {field.constraints.min_length !== null
            ? '最少 ' + field.constraints.min_length + ' 字；'
            : ''}
          {field.constraints.accept
            ? '文件格式 ' + field.constraints.accept + '；'
            : ''}
          {field.constraints.multiple ? '允许多选；' : ''}
          {field.constraints.pattern ? '有格式约束；' : ''}
          {field.constraints.step ? '步长 ' + field.constraints.step : ''}
        </p>
      </details>
      <details>
        <summary>人工标注字段含义</summary>
        <p className="scan-small">
          只修改扫描预览，不改变网页。原识别标签：{field.label}
        </p>
        <label>
          字段标注
          <input
            value={label}
            maxLength={200}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <button
          disabled={busy || !label.trim()}
          onClick={() =>
            act('scan.annotate', {
              ref: snapshotRef(snapshot),
              field_id: field.field_id,
              label: label.trim(),
            })
          }
        >
          保存标注
        </button>
      </details>
    </article>
  );
}
export function ScanPanel({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<ScanData>({
    session: null,
    snapshot: null,
    status: 'idle',
  });
  const [tabs, setTabs] = useState<TabChoice[]>([]);
  const [selected, setSelected] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  async function refresh() {
    const started = generation.current;
    try {
      const value = (await request('scan.get')) as ScanData;
      if (mounted.current && started === generation.current) {
        setData(value);
        if (value.status === 'unavailable')
          setMessage('页面已变化或扫描会话不可用，请重新开始扫描');
      }
    } catch (error) {
      if (started !== generation.current) return;
      throw error;
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => undefined);
    const updateTabs = () => {
      void chrome.tabs.query({ currentWindow: true }).then((items) => {
        if (!mounted.current) return;
        const choices = items
          .filter(
            (tab) =>
              tab.id !== undefined && tab.url && /^https?:/.test(tab.url),
          )
          .map((tab) => {
            const url = new URL(tab.url!);
            return {
              id: tab.id!,
              label: url.hostname + safeRoute(url.href),
              active: tab.active,
            };
          });
        setTabs(choices);
        const active = items.find((tab) => tab.active);
        if (
          active?.id !== undefined &&
          (!active.url || /^https?:/.test(active.url))
        )
          setSelected(active.url ? String(active.id) : '');
        else
          setSelected((current) =>
            choices.some((tab) => String(tab.id) === current)
              ? current
              : String(choices[0]?.id ?? ''),
          );
      });
    };
    updateTabs();
    chrome.tabs.onActivated.addListener(updateTabs);
    chrome.tabs.onUpdated.addListener(updateTabs);
    const timer = setInterval(() => {
      if (!busyRef.current)
        void refresh().catch(() => {
          if (mounted.current)
            setData((old) => ({
              ...old,
              snapshot: null,
              status: 'unavailable',
            }));
        });
    }, 1300);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      chrome.tabs.onActivated.removeListener(updateTabs);
      chrome.tabs.onUpdated.removeListener(updateTabs);
    };
  }, []);
  async function action(method: string, extra: Record<string, unknown> = {}) {
    if (busyRef.current) return;
    generation.current++;
    busyRef.current = true;
    setBusy(true);
    setMessage('');
    try {
      let args = extra,
        task_id: string | null = data.session?.task_id ?? null;
      if (method === 'scan.start') {
        let tabId = selected ? Number(selected) : undefined;
        if (tabId === undefined) {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          tabId = tab?.id;
        }
        if (tabId === undefined) throw new Error('请先打开需要扫描的网页');
        args = { tab_id: tabId };
        task_id = null;
      } else if (method === 'scan.refresh' || method === 'scan.stop') {
        if (!data.session) throw new Error('请先扫描页面');
        args = { tab_id: data.session.tab_id };
      }
      const result = await request(method, args, task_id);
      if (method === 'scan.locate') {
        setMessage('已在网页中标出该字段，未修改字段内容');
        await refresh();
      } else {
        setData(result as ScanData);
        setMessage(
          method === 'scan.stop'
            ? '扫描已停止，页面快照已清除'
            : method === 'scan.annotate'
              ? '标注已保存；仅在当前扫描会话中有效'
              : '扫描预览已更新，请核对字段与分组',
        );
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '扫描失败');
      await refresh().catch(() =>
        setData({ session: null, snapshot: null, status: 'unavailable' }),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function openPanel() {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id === undefined) throw new Error();
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch {
      setMessage(
        '请从浏览器侧栏菜单打开 FormPilot，或在网页上重新点击扩展图标',
      );
    }
  }
  const snapshot = data.snapshot;
  const shown = snapshot
    ? compact
      ? snapshot.fields.slice(0, 3)
      : snapshot.fields
    : [];
  return (
    <section className="scanner">
      <h2>网页表单扫描</h2>
      <p className="scan-small">
        由你启动后读取所选页面的表单字段，结果只保留在当前扫描会话，不发送给模型。此阶段不会填写或提交网页。
      </p>
      {tabs.length > 0 && (
        <label>
          要扫描的标签页
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {tabs.map((tab) => (
              <option key={tab.id} value={tab.id}>
                {tab.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="scan-actions">
        <button disabled={busy} onClick={() => void action('scan.start')}>
          开始扫描
        </button>
        {compact && (
          <button onClick={() => void openPanel()}>打开扫描侧栏</button>
        )}
        {data.session && (
          <>
            <button disabled={busy} onClick={() => void action('scan.refresh')}>
              重新扫描
            </button>
            <button disabled={busy} onClick={() => void action('scan.stop')}>
              停止扫描
            </button>
          </>
        )}
      </div>
      <p className="scan-status" data-testid="scan-status" aria-live="polite">
        {message ||
          (data.status === 'idle'
            ? '尚未扫描'
            : data.status === 'unavailable'
              ? '页面已变化或会话不可用，请重新扫描'
              : snapshot
                ? '扫描会话中，页面变化会自动重扫'
                : '正在读取扫描结果')}
      </p>
      {snapshot && (
        <>
          <p className="scan-summary" data-testid="scan-summary">
            发现 {snapshot.fields.length} 个字段 · {snapshot.groups.length}{' '}
            个分组{snapshot.complete ? '' : ' · 结果不完整'}
          </p>
          <p className="scan-small">
            {siteProfile(new URL(snapshot.origin).hostname).name} ·{' '}
            {snapshot.origin}
            {snapshot.route}
            <br />
            当前采用原生控件通用识别，站点专有申请表尚待验证。
          </p>
          {snapshot.warnings.map((warning) => (
            <p className="scan-warning" key={warning.code}>
              {warnings[warning.code] ?? '部分字段需要人工核对'}（
              {warning.count}）
            </p>
          ))}
          {!snapshot.fields.length && (
            <p className="scan-warning">
              当前页面没有可读取的表单字段。若申请表需要登录，请先自行登录并打开实际表单后重新扫描。
            </p>
          )}
          {snapshot.groups
            .filter((group) =>
              shown.some((field) => field.group_id === group.group_id),
            )
            .map((group) => (
              <div className="scan-group" key={group.group_id}>
                <h3>{group.label}</h3>
                {shown
                  .filter((field) => field.group_id === group.group_id)
                  .map((field) => (
                    <FieldCard
                      key={field.field_id + snapshot.dom_fingerprint}
                      field={field}
                      snapshot={snapshot}
                      busy={busy}
                      act={(method, args) => void action(method, args)}
                    />
                  ))}
              </div>
            ))}
          {compact && snapshot.fields.length > shown.length && (
            <p className="scan-small">
              这里只预览前 {shown.length} 个字段，请打开扫描侧栏查看全部结果。
            </p>
          )}
          <p className="scan-small">
            扫描会话最多 15
            分钟；导航、权限变化或页面刷新可能需要重新启动。人工标注不会永久保存。
          </p>
        </>
      )}
    </section>
  );
}
