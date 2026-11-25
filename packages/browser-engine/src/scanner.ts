import type {
  FormSnapshot,
  ScannedField,
  ScanGroup,
  ScanRef,
  ScanSession,
  ErrorCode,
} from '@formpilot/contracts';
import { siteProfile } from './sites';
export const ADAPTER_VERSION = 'native-0.2.0';
export const CONTROL_SELECTOR =
  'input,textarea,select,[role="combobox"],[role="listbox"],[role="textbox"],[contenteditable="true"]';
const GROUP_SELECTOR = 'fieldset,[role="group"],[data-form-group],section';
const nativeTypes = new Set([
  'text',
  'email',
  'tel',
  'date',
  'month',
  'textarea',
  'select',
  'radio',
  'checkbox',
]);
const sensitive =
  /密码|验证码|校验码|短信码|安全码|支付|银行卡|信用卡|身份证|护照|password|passcode|captcha|verification[ _-]?code|one[ _-]?time[ _-]?code|credit[ _-]?card|card[ _-]?number|security[ _-]?code|payment|passport|national[ _-]?id/i;
const clip = (text: string, max = 200) =>
  text.replace(/\s+/g, ' ').trim().slice(0, max);
const random = () => crypto.randomUUID();
export class ScannerFault extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}
export function safeRoute(href: string) {
  const url = new URL(href);
  const hash = url.hash.startsWith('#/')
    ? url.hash.slice(1).split('?')[0]!
    : '';
  return (url.pathname + (hash ? '#' + hash : ''))
    .split('/')
    .map((segment) =>
      /(@|%40)|[a-f0-9]{16,}|[a-zA-Z0-9_-]{30,}|\d{6,}/i.test(segment)
        ? ':private'
        : segment,
    )
    .join('/')
    .slice(0, 300);
}
export function structuralProjection(
  fields: ScannedField[],
  groups: ScanGroup[],
) {
  return {
    adapter_version: ADAPTER_VERSION,
    groups,
    fields: fields.map(
      ({ current_value: _value, manual_label: _manual, ...field }) => field,
    ),
  };
}
async function hash(text: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
function labelText(element: Element | null) {
  if (!element) return '';
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let text = '';
  let node: Node | null;
  while ((node = walker.nextNode()) && text.length < 4096) {
    if (
      node.parentElement?.closest(
        'input,select,textarea,button,script,style,[aria-hidden="true"]',
      )
    )
      continue;
    text += ' ' + node.textContent;
  }
  return text.replace(/\s+/g, ' ').trim();
}
function referenceText(element: Element, attribute: string) {
  return (element.getAttribute(attribute) ?? '')
    .split(/\s+/)
    .slice(0, 10)
    .map((id) => {
      if (!id) return '';
      const matches = document.querySelectorAll(
        '[id="' + CSS.escape(id) + '"]',
      );
      return matches.length === 1 ? labelText(matches[0]!) : '';
    })
    .join(' ')
    .trim();
}
function fieldLabel(element: HTMLElement): { label: string; source: string } {
  const aria = referenceText(element, 'aria-labelledby');
  if (aria) return { label: aria, source: 'aria-labelledby' };
  const explicit = element.getAttribute('aria-label');
  if (explicit?.trim()) return { label: explicit.trim(), source: 'aria-label' };
  const labels =
    'labels' in element
      ? (element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)
          .labels
      : null;
  const associated = labels
    ? Array.from(labels).map(labelText).filter(Boolean).join(' ')
    : '';
  if (associated) return { label: associated, source: 'label' };
  const nested = element.querySelector<HTMLInputElement>(
    'input,textarea,select',
  );
  if (nested) {
    const result = fieldLabel(nested);
    if (result.label) return result;
  }
  for (const attr of ['placeholder', 'title', 'name', 'id']) {
    const value = element.getAttribute(attr);
    if (value?.trim()) return { label: value.trim(), source: attr };
  }
  return { label: '未识别字段', source: 'unknown' };
}
function visible(element: HTMLElement) {
  if (
    element.closest('[hidden],[inert],[aria-hidden="true"]') ||
    element.getClientRects().length === 0
  )
    return false;
  for (
    let current: HTMLElement | null = element;
    current;
    current = current.parentElement
  ) {
    const style = getComputedStyle(current);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.opacity === '0'
    )
      return false;
  }
  return true;
}
function enabled(element: HTMLElement) {
  return (
    !element.matches(':disabled') &&
    element.getAttribute('aria-disabled') !== 'true'
  );
}
function native(
  element: Element,
): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  );
}
interface RawSnapshot {
  fields: ScannedField[];
  groups: ScanGroup[];
  warnings: FormSnapshot['warnings'];
  excluded: FormSnapshot['excluded'];
  complete: boolean;
  refs: Map<string, HTMLElement[]>;
  structure: string;
  values: string;
  route: string;
}
export class FormScanner {
  private readonly identities = new WeakMap<Element, string>();
  private readonly groupIds = new WeakMap<Element, string>();
  private readonly formIds = new WeakMap<Element, string>();
  private readonly locatorIds = new WeakMap<Element, string>();
  private current: FormSnapshot | null = null;
  private refs = new Map<string, HTMLElement[]>();
  private annotations = new Map<string, string>();
  private annotationEpoch = 0;
  get annotationRevision() {
    return this.annotationEpoch;
  }
  private pageId = random();
  private href = location.href;
  private revision = 0;
  private stopped = false;
  private queue: Promise<unknown> = Promise.resolve();
  private observer: MutationObserver | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private overlay: HTMLElement | null = null;
  private overlayTimer: ReturnType<typeof setTimeout> | null = null;
  private onChange:
    | ((snapshot: FormSnapshot | null, code: string | null) => void)
    | null = null;
  constructor(readonly session: ScanSession) {}
  private identity(map: WeakMap<Element, string>, element: Element) {
    let value = map.get(element);
    if (!value) {
      value = random();
      map.set(element, value);
    }
    return value;
  }
  private groupsFor(element: HTMLElement, groups: Map<string, ScanGroup>) {
    const form =
      native(element) && element.form
        ? element.form
        : (element.closest('form') ?? document.body);
    const form_id = this.identity(this.formIds, form);
    const nearest = element.closest(GROUP_SELECTOR);
    const group = nearest && form.contains(nearest) ? nearest : form;
    const group_id = this.identity(this.groupIds, group);
    const add = (container: Element): string => {
      const id = this.identity(this.groupIds, container);
      if (groups.has(id)) return id;
      const parent = container.parentElement?.closest(GROUP_SELECTOR);
      const parent_group_id =
        parent &&
        parent !== container &&
        form.contains(parent) &&
        parent !== document.documentElement
          ? add(parent)
          : null;
      const heading = container.querySelector(
        ':scope > legend,:scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > header > h2,:scope > header > h3',
      );
      const label =
        container.getAttribute('aria-label') ||
        referenceText(container, 'aria-labelledby') ||
        labelText(heading) ||
        (container === form ? '表单' : '未命名经历组');
      groups.set(id, {
        group_id: id,
        form_id,
        label: clip(label),
        parent_group_id,
      });
      return id;
    };
    add(group);
    return { form_id, group_id };
  }
  private capture(): RawSnapshot {
    if (this.stopped) throw new ScannerFault('SNAPSHOT_EXPIRED');
    if (this.session.expires_at < Date.now())
      throw new ScannerFault('SNAPSHOT_EXPIRED');
    if (location.href !== this.href) {
      this.href = location.href;
      this.pageId = random();
      this.annotations.clear();
      this.current = null;
      this.refs.clear();
    }
    const fields: ScannedField[] = [];
    const groups = new Map<string, ScanGroup>();
    const refs = new Map<string, HTMLElement[]>();
    const excluded = { hidden: 0, sensitive: 0, actions: 0 };
    const counts = new Map<string, number>();
    const warn = (code: string, count = 1) =>
      counts.set(code, (counts.get(code) ?? 0) + count);
    let complete = true,
      bytes = 0;
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(CONTROL_SELECTOR),
    );
    const eligible: HTMLElement[] = [];
    for (const element of nodes) {
      const type =
        element instanceof HTMLInputElement
          ? element.type.toLowerCase()
          : element instanceof HTMLTextAreaElement
            ? 'textarea'
            : element instanceof HTMLSelectElement
              ? 'select'
              : 'custom';
      if (['button', 'submit', 'reset', 'image'].includes(type)) {
        excluded.actions++;
        continue;
      }
      if (type === 'hidden' || !visible(element)) {
        excluded.hidden++;
        continue;
      }
      const name = [
        element.getAttribute('name'),
        element.id,
        element.getAttribute('placeholder'),
        element.getAttribute('autocomplete'),
        fieldLabel(element).label,
        labelText(
          element
            .closest(GROUP_SELECTOR)
            ?.querySelector(':scope > legend,:scope > h2,:scope > h3') ?? null,
        ),
      ].join(' ');
      if (
        type === 'password' ||
        sensitive.test(name) ||
        /(^|\s)cc-[a-z-]+($|\s)/i.test(
          element.getAttribute('autocomplete') ?? '',
        )
      ) {
        excluded.sensitive++;
        continue;
      }
      const composite = element.parentElement?.closest(
        '[role="combobox"],[role="listbox"],[contenteditable="true"]',
      );
      if (composite && visible(composite as HTMLElement)) continue;
      eligible.push(element);
    }
    const consumed = new Set<HTMLElement>();
    for (const element of eligible) {
      if (consumed.has(element)) continue;
      if (fields.length >= 250) {
        complete = false;
        warn('FIELD_LIMIT', eligible.length - consumed.size);
        break;
      }
      consumed.add(element);
      let controls = [element];
      const type =
        element instanceof HTMLInputElement
          ? element.type.toLowerCase()
          : element instanceof HTMLTextAreaElement
            ? 'textarea'
            : element instanceof HTMLSelectElement
              ? 'select'
              : 'custom';
      if (type === 'radio' && element.getAttribute('name')) {
        controls = eligible.filter(
          (other) =>
            other instanceof HTMLInputElement &&
            other.type === 'radio' &&
            other.name === (element as HTMLInputElement).name &&
            other.form === (element as HTMLInputElement).form,
        );
        controls.forEach((control) => consumed.add(control));
      }
      const field_id = this.identity(this.identities, element),
        locator_ref = this.identity(this.locatorIds, element);
      const grouping = this.groupsFor(element, groups);
      const identified = fieldLabel(element);
      let label = identified.label,
        label_source = identified.source;
      let manual_reason: string | null = null;
      const readonly =
        native(element) && 'readOnly' in element
          ? element.readOnly
          : element.getAttribute('aria-readonly') === 'true';
      const fieldEnabled = controls.some(enabled);
      let options: ScannedField['options'] = [];
      let option_count = 0;
      let value: ScannedField['current_value'] = null;
      if (element instanceof HTMLSelectElement) {
        option_count = element.options.length;
        options = Array.from(element.options)
          .slice(0, 200)
          .map((option) => ({
            value: option.value.slice(0, 4096),
            label: clip(option.textContent ?? ''),
            disabled:
              option.disabled ||
              option.hidden ||
              (option.parentElement instanceof HTMLOptGroupElement &&
                option.parentElement.disabled),
          }));
        value = element.multiple
          ? Array.from(element.selectedOptions).map((option) => option.value)
          : element.value;
      } else if (type === 'radio') {
        option_count = controls.length;
        options = controls.slice(0, 200).map((control) => ({
          value: (control as HTMLInputElement).value.slice(0, 4096),
          label: clip(fieldLabel(control).label),
          disabled: !enabled(control),
        }));
        const checked = controls.find(
          (control) => (control as HTMLInputElement).checked,
        );
        value = checked ? (checked as HTMLInputElement).value : null;
        const group = document.querySelectorAll(
          'fieldset,[role="group"],[data-form-group]',
        );
        const nearest = element.closest(
          'fieldset,[role="group"],[data-form-group]',
        );
        const heading = nearest?.querySelector(':scope > legend');
        if (heading) {
          label = labelText(heading);
          label_source = 'legend';
        }
        if (
          group.length &&
          controls.some(
            (control) =>
              control.closest('fieldset,[role="group"],[data-form-group]') !==
              nearest,
          )
        )
          manual_reason = 'AMBIGUOUS_RADIO_GROUP';
      } else if (type === 'checkbox') {
        value = (element as HTMLInputElement).checked;
        option_count = 1;
        options = [
          {
            value: (element as HTMLInputElement).value.slice(0, 4096),
            label: clip(label),
            disabled: !fieldEnabled,
          },
        ];
      } else if (type === 'file') {
        manual_reason = 'FILE_MANUAL';
      } else if (native(element)) value = element.value;
      if (type === 'custom') manual_reason = 'CUSTOM_CONTROL';
      else if (!nativeTypes.has(type) && type !== 'file')
        manual_reason = 'CONTROL_UNSUPPORTED';
      if (!fieldEnabled) manual_reason = 'DISABLED';
      if (readonly) manual_reason = 'READ_ONLY';
      if (
        options.length > 1 &&
        new Set(options.map((option) => option.value)).size !== options.length
      ) {
        manual_reason = 'AMBIGUOUS_OPTIONS';
        warn('AMBIGUOUS_OPTIONS');
      }
      if (
        element instanceof HTMLSelectElement &&
        Array.from(element.options)
          .slice(0, 200)
          .some(
            (option) =>
              option.value.length > 4096 ||
              (option.textContent?.length ?? 0) > 200,
          )
      ) {
        manual_reason = 'METADATA_LIMIT';
        complete = false;
        warn('METADATA_LIMIT');
      }
      if (
        controls.some(
          (control) =>
            control instanceof HTMLInputElement &&
            ['radio', 'checkbox'].includes(control.type) &&
            control.value.length > 4096,
        )
      ) {
        manual_reason = 'METADATA_LIMIT';
        complete = false;
        warn('METADATA_LIMIT');
      }
      if (option_count > 200) {
        manual_reason = 'OPTIONS_LIMIT';
        complete = false;
        warn('OPTIONS_LIMIT');
      }
      if (
        (typeof value === 'string' && value.length > 4096) ||
        (Array.isArray(value) &&
          (value.length > 200 || value.some((v) => v.length > 4096)))
      ) {
        value = null;
        manual_reason = 'VALUE_LIMIT';
        complete = false;
        warn('VALUE_LIMIT');
      }
      if (
        element.id &&
        document.querySelectorAll('[id="' + CSS.escape(element.id) + '"]')
          .length !== 1
      ) {
        manual_reason = 'DUPLICATE_HTML_ID';
        warn('DUPLICATE_HTML_ID');
      }
      const constraint = (name: string, max: number) => {
        const value = element.getAttribute(name);
        if (value !== null && value.length > max) {
          manual_reason = 'METADATA_LIMIT';
          complete = false;
          warn('METADATA_LIMIT');
        }
        return value === null ? null : value.slice(0, max);
      };
      const integer = (name: string) => {
        const value = element.getAttribute(name);
        return value !== null &&
          /^\d+$/.test(value) &&
          Number.isSafeInteger(Number(value))
          ? Number(value)
          : null;
      };
      const constraints = {
        min: constraint('min', 200),
        max: constraint('max', 200),
        step: constraint('step', 100),
        pattern: constraint('pattern', 500),
        min_length: integer('minlength'),
        max_length: integer('maxlength'),
        accept: constraint('accept', 500),
        multiple: element.hasAttribute('multiple'),
      };
      if (
        label.length > 200 ||
        ['name', 'id', 'placeholder'].some(
          (attr) => (element.getAttribute(attr)?.length ?? 0) > 200,
        )
      ) {
        manual_reason = 'METADATA_LIMIT';
        complete = false;
        warn('METADATA_LIMIT');
      }
      const field: ScannedField = {
        field_id,
        locator_ref,
        ...grouping,
        label: clip(label),
        label_source,
        manual_label: this.annotations.get(field_id) ?? null,
        description: clip(referenceText(element, 'aria-describedby'), 500),
        name: clip(element.getAttribute('name') ?? ''),
        html_id: clip(element.id),
        placeholder: clip(element.getAttribute('placeholder') ?? ''),
        control_type: type === 'tel' ? 'phone' : type,
        required: controls.some(
          (control) =>
            (native(control) && control.required) ||
            control.getAttribute('aria-required') === 'true',
        ),
        visible: true,
        enabled: fieldEnabled,
        read_only: readonly,
        supported: manual_reason === null,
        manual_reason,
        current_value: value,
        options,
        option_count,
        constraints,
      };
      bytes += JSON.stringify(field).length;
      if (bytes > 1500000) throw new ScannerFault('SCAN_LIMIT_EXCEEDED');
      fields.push(field);
      refs.set(field_id, controls);
    }
    const iframes = Array.from(
      document.querySelectorAll<HTMLIFrameElement>('iframe'),
    ).filter(visible).length;
    if (iframes) warn('IFRAME_NOT_SCANNED', iframes);
    const shadows = Array.from(document.querySelectorAll('*'))
      .slice(0, 20000)
      .filter((element) => element.shadowRoot !== null).length;
    if (shadows) warn('SHADOW_DOM_NOT_SCANNED', shadows);
    if (excluded.sensitive)
      warn('SENSITIVE_FIELDS_EXCLUDED', excluded.sensitive);
    const warnings = [...counts].map(([code, count]) => ({ code, count }));
    const groupList = [...groups.values()];
    if (groupList.length > 500) throw new ScannerFault('SCAN_LIMIT_EXCEEDED');
    return {
      fields,
      groups: groupList,
      warnings,
      excluded,
      complete,
      refs,
      structure: JSON.stringify({
        ...structuralProjection(fields, groupList),
        warnings: warnings.filter(
          (warning) => warning.code !== 'SENSITIVE_FIELDS_EXCLUDED',
        ),
        complete,
      }),
      values: JSON.stringify(fields.map((f) => [f.field_id, f.current_value])),
      route: location.href,
    };
  }
  async scan(force = false): Promise<FormSnapshot> {
    const run = async () => {
      const start = performance.now();
      let raw: RawSnapshot | null = null;
      let fingerprint = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const first = this.capture();
        fingerprint = await hash(first.structure);
        const second = this.capture();
        if (
          first.structure === second.structure &&
          first.values === second.values &&
          first.route === second.route
        ) {
          raw = second;
          break;
        }
      }
      if (!raw) throw new ScannerFault('PAGE_CHANGED');
      if (this.stopped) throw new ScannerFault('SNAPSHOT_EXPIRED');
      const previous = this.current;
      if (previous?.dom_fingerprint !== fingerprint) {
        this.annotations.clear();
        raw.fields.forEach((field) => (field.manual_label = null));
      }
      if (
        !force &&
        previous &&
        previous.page_instance_id === this.pageId &&
        previous.dom_fingerprint === fingerprint &&
        JSON.stringify(
          previous.fields.map((f) => [f.field_id, f.current_value]),
        ) === raw.values
      ) {
        this.refs = raw.refs;
        return previous;
      }
      const current: FormSnapshot = {
        protocol_version: '1',
        task_id: this.session.task_id,
        tab_id: this.session.tab_id,
        frame_id: 0,
        page_instance_id: this.pageId,
        form_snapshot_id: random(),
        dom_fingerprint: fingerprint,
        snapshot_revision: ++this.revision,
        origin: location.origin,
        route: safeRoute(location.href),
        adapter_version: ADAPTER_VERSION,
        site_id: siteProfile(location.hostname).id,
        captured_at: Date.now(),
        duration_ms: performance.now() - start,
        complete: raw.complete,
        fields: raw.fields,
        groups: raw.groups,
        warnings: raw.warnings,
        excluded: raw.excluded,
      };
      this.refs = raw.refs;
      this.current = current;
      return current;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
  async read() {
    return this.scan();
  }
  async locate(ref: ScanRef, field_id: string, highlight = false) {
    if (this.stopped || this.session.expires_at < Date.now())
      throw new ScannerFault('SNAPSHOT_EXPIRED');
    if (
      ref.task_id !== this.session.task_id ||
      ref.tab_id !== this.session.tab_id ||
      ref.frame_id !== 0
    )
      throw new ScannerFault('SCOPE_DENIED');
    const snapshot = await this.scan();
    if (ref.page_instance_id !== snapshot.page_instance_id)
      throw new ScannerFault('PAGE_CHANGED');
    if (
      ref.form_snapshot_id !== snapshot.form_snapshot_id ||
      ref.dom_fingerprint !== snapshot.dom_fingerprint
    )
      throw new ScannerFault('STALE_SNAPSHOT');
    const controls = this.refs.get(field_id);
    if (!controls?.length) throw new ScannerFault('FIELD_NOT_FOUND');
    const element = controls.find(
      (control) =>
        control.isConnected &&
        control.ownerDocument === document &&
        visible(control),
    );
    if (!element) throw new ScannerFault('FIELD_NOT_FOUND');
    if (highlight) {
      element.scrollIntoView({
        block: 'center',
        inline: 'nearest',
        behavior: 'instant',
      });
      this.overlay?.remove();
      if (this.overlayTimer) clearTimeout(this.overlayTimer);
      const rect = element.getBoundingClientRect();
      const overlay = document.createElement('div');
      overlay.setAttribute('aria-hidden', 'true');
      Object.assign(overlay.style, {
        position: 'fixed',
        left: rect.x + 'px',
        top: rect.y + 'px',
        width: rect.width + 'px',
        height: rect.height + 'px',
        outline: '3px solid #365edb',
        background: 'rgba(54,94,219,0.08)',
        pointerEvents: 'none',
        zIndex: '2147483647',
        borderRadius: '3px',
      });
      document.documentElement.append(overlay);
      this.overlay = overlay;
      this.overlayTimer = setTimeout(() => {
        overlay.remove();
        if (this.overlay === overlay) this.overlay = null;
      }, 1600);
    }
    const rect = element.getBoundingClientRect();
    return {
      field_id,
      matched: true as const,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }
  async guardExecution(ref: ScanRef, exact = false) {
    if (this.stopped || this.session.expires_at <= Date.now())
      throw new ScannerFault('SNAPSHOT_EXPIRED');
    const snapshot = await this.scan();
    if (
      ref.task_id !== snapshot.task_id ||
      ref.tab_id !== snapshot.tab_id ||
      ref.frame_id !== 0
    )
      throw new ScannerFault('SCOPE_DENIED');
    if (
      ref.page_instance_id !== snapshot.page_instance_id ||
      ref.dom_fingerprint !== snapshot.dom_fingerprint
    )
      throw new ScannerFault('PAGE_CHANGED');
    if (exact && ref.form_snapshot_id !== snapshot.form_snapshot_id)
      throw new ScannerFault('STALE_SNAPSHOT');
    return snapshot;
  }
  async executionField(ref: ScanRef, field_id: string) {
    const snapshot = await this.guardExecution(ref);
    const field = snapshot.fields.find((f) => f.field_id === field_id),
      controls = this.refs.get(field_id);
    if (
      !field ||
      !controls?.length ||
      controls.some(
        (c) => !c.isConnected || c.ownerDocument !== document || !visible(c),
      )
    )
      throw new ScannerFault('LOCATOR_NOT_FOUND');
    return { snapshot, field, controls };
  }
  async annotate(ref: ScanRef, field_id: string, label: string) {
    if (!label.trim() || label.length > 200)
      throw new ScannerFault('INVALID_REQUEST');
    await this.locate(ref, field_id);
    this.annotations.set(field_id, label.trim());
    this.annotationEpoch++;
    return this.scan(true);
  }
  watch(
    callback: (snapshot: FormSnapshot | null, code: string | null) => void,
  ) {
    this.onChange = callback;
    const update = () => {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        void this.scan()
          .then((snapshot) => this.onChange?.(snapshot, null))
          .catch((error) =>
            this.onChange?.(
              null,
              error instanceof ScannerFault ? error.code : 'PAGE_CHANGED',
            ),
          );
      }, 180);
    };
    const related = (node: Node): boolean => {
      const element = node instanceof Element ? node : node.parentElement;
      return (
        !!element &&
        element !== this.overlay &&
        (element.matches(CONTROL_SELECTOR + ',label,legend,option,optgroup') ||
          !!element.querySelector(CONTROL_SELECTOR) ||
          !!element.closest(
            'label,legend,option,[aria-labelledby],[aria-describedby]',
          ))
      );
    };
    this.observer = new MutationObserver((records) => {
      if (
        records.some((record) =>
          record.type === 'childList'
            ? [...record.addedNodes, ...record.removedNodes].some(related) ||
              !!(
                record.target instanceof Element &&
                record.target.closest('label,legend,option,h1,h2,h3,h4')
              )
            : related(record.target),
        )
      )
        update();
    });
    this.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'id',
        'name',
        'type',
        'value',
        'checked',
        'selected',
        'required',
        'disabled',
        'readonly',
        'multiple',
        'min',
        'max',
        'step',
        'pattern',
        'minlength',
        'maxlength',
        'accept',
        'hidden',
        'inert',
        'class',
        'style',
        'aria-label',
        'aria-labelledby',
        'aria-describedby',
        'aria-required',
        'aria-disabled',
        'aria-hidden',
        'placeholder',
        'form',
        'role',
        'contenteditable',
      ],
    });
    document.addEventListener('input', this.onInput, true);
    document.addEventListener('change', this.onInput, true);
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    this.routeCleanup = () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener('hashchange', update);
    };
    this.interval = setInterval(() => {
      if (this.session.expires_at < Date.now()) {
        this.stop();
        callback(null, 'SNAPSHOT_EXPIRED');
        return;
      }
      if (!document.hidden || location.href !== this.href) update();
    }, 800);
  }
  private routeCleanup: (() => void) | null = null;
  private onInput = (event: Event) => {
    if (
      event.target instanceof HTMLElement &&
      [...this.refs.values()].some((controls) =>
        controls.includes(event.target as HTMLElement),
      )
    ) {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        void this.scan()
          .then((snapshot) => this.onChange?.(snapshot, null))
          .catch(() => this.onChange?.(null, 'PAGE_CHANGED'));
      }, 120);
    }
  };
  stop() {
    this.stopped = true;
    this.current = null;
    this.refs.clear();
    this.annotations.clear();
    this.observer?.disconnect();
    if (this.interval) clearInterval(this.interval);
    if (this.debounce) clearTimeout(this.debounce);
    if (this.overlayTimer) clearTimeout(this.overlayTimer);
    this.overlay?.remove();
    this.onChange = null;
    this.routeCleanup?.();
    document.removeEventListener('input', this.onInput, true);
    document.removeEventListener('change', this.onInput, true);
  }
}
