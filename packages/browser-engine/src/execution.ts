import { Value } from '@sinclair/typebox/value';
import {
  ExecutionPacketSchema,
  canonicalJson,
  snapshotRef,
  sameExecutionScope,
  type ExecutionPacket,
  type ExecutionCheckpoint,
  type ExecutionView,
  type ExecutionFieldResult,
  type BrowserExecutionState,
  type FieldValue,
  type ScanRef,
  type ErrorCode,
} from '@formpilot/contracts';
import { FormScanner, ScannerFault } from './scanner';
export const EXECUTOR_VERSION = 'native-executor-0.4.0';
export const STABLE_WINDOW_MS = 500;
export const VERIFY_TIMEOUT_MS = 2000;
const SAMPLE_MS = 100;
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const code = (e: unknown): ErrorCode =>
  e instanceof ScannerFault ? e.code : 'EXECUTION_INTERRUPTED';
interface Run {
  packet: ExecutionPacket;
  state: BrowserExecutionState;
  cancelled: boolean;
  editVersions: Map<string, number>;
  prepared: Set<string>;
  annotationRevision: number;
}
export class FormExecutor {
  private runs = new Map<string, Run>();
  private active: Run | null = null;
  private stopped = false;
  private tracked = new WeakMap<Element, string>();
  private edits = new Map<string, number>();
  private self = new Set<Element>();
  private epoch = 0;
  constructor(
    private scanner: FormScanner,
    private checkpoint: (
      request: ExecutionCheckpoint,
    ) => Promise<ExecutionView>,
  ) {
    document.addEventListener('input', this.onEdit, true);
    document.addEventListener('change', this.onEdit, true);
    document.addEventListener('beforeinput', this.onEdit, true);
  }
  private onEdit = (event: Event) => {
    const node = event.target;
    if (!(node instanceof Element) || this.self.has(node)) return;
    const id = this.tracked.get(node);
    if (id) this.edits.set(id, (this.edits.get(id) ?? 0) + 1);
  };
  private check(run: Run) {
    if (this.scanner.annotationRevision !== run.annotationRevision)
      throw new ScannerFault('PAGE_CHANGED');
    if (this.stopped || run.cancelled)
      throw new ScannerFault('EXECUTION_INTERRUPTED');
    if (run.packet.expires_at < Date.now())
      throw new ScannerFault('EXECUTION_EXPIRED');
  }
  private failRow(
    item: ExecutionPacket['items'][number],
    reason: ErrorCode,
    actual: FieldValue = null,
  ): ExecutionFieldResult {
    return {
      field_id: item.field.field_id,
      before: item.before,
      target: item.target,
      actual,
      status: 'failed',
      error_code: reason,
    };
  }
  async start(
    packet: ExecutionPacket,
    started_at: number,
  ): Promise<BrowserExecutionState> {
    if (!Value.Check(ExecutionPacketSchema, packet))
      throw new ScannerFault('INVALID_REQUEST');
    const prior = this.runs.get(packet.execution_id);
    if (prior) {
      if (!equal(prior.packet, packet)) throw new ScannerFault('SCOPE_DENIED');
      return structuredClone(prior.state);
    }
    if (this.stopped || this.active?.state.running)
      throw new ScannerFault('EXECUTION_LOCKED');
    if (packet.execution_epoch <= this.epoch)
      throw new ScannerFault('REVISION_CONFLICT');
    const snapshot = await this.scanner.guardExecution(
      packet.observed_snapshot_ref,
      true,
    );
    if (!sameExecutionScope(snapshotRef(snapshot), packet.snapshot_ref))
      throw new ScannerFault('PAGE_CHANGED');
    const ids = packet.items.map((i) => i.field.field_id);
    if (new Set(ids).size !== ids.length)
      throw new ScannerFault('RULE_VIOLATION');
    if (
      packet.action !== 'fill' &&
      !this.runs.has(packet.source_execution_id ?? '')
    )
      throw new ScannerFault('EXECUTION_INTERRUPTED');
    for (const item of packet.items) {
      const current = await this.scanner.executionField(
        packet.snapshot_ref,
        item.field.field_id,
      );
      if (
        !current.field.supported ||
        !current.field.enabled ||
        current.field.read_only ||
        (current.field.control_type === 'checkbox' &&
          /同意|隐私|条款|承诺|授权|声明|terms|privacy|consent|agree/i.test(
            [
              current.field.label,
              current.field.manual_label,
              current.field.description,
              current.field.name,
            ].join(' '),
          ))
      )
        throw new ScannerFault('CONTROL_UNSUPPORTED');
      if (
        current.field.locator_ref !== item.field.locator_ref ||
        !equal(
          { ...current.field, current_value: null },
          { ...item.field, current_value: null },
        )
      )
        throw new ScannerFault('PAGE_CHANGED');
      for (const control of current.controls)
        this.tracked.set(control, item.field.field_id);
    }
    // Recheck after asynchronous hashing and locator resolution.
    await this.scanner.guardExecution(packet.observed_snapshot_ref, true);
    const raced = this.runs.get(packet.execution_id);
    if (raced) {
      if (!equal(raced.packet, packet)) throw new ScannerFault('SCOPE_DENIED');
      return structuredClone(raced.state);
    }
    if (
      this.stopped ||
      this.active?.state.running ||
      packet.execution_epoch <= this.epoch
    )
      throw new ScannerFault('EXECUTION_LOCKED');
    this.epoch = packet.execution_epoch;
    const run: Run = {
      packet: structuredClone(packet),
      state: {
        execution_id: packet.execution_id,
        execution_epoch: packet.execution_epoch,
        running: true,
        sequence: 0,
        report: {
          execution_id: packet.execution_id,
          started_at,
          ended_at: started_at,
          field_results: [],
        },
        written_field_ids: [],
        last_error: null,
      },
      cancelled: false,
      editVersions: new Map(),
      prepared: new Set(),
      annotationRevision: this.scanner.annotationRevision,
    };
    this.active = run;
    this.runs.set(packet.execution_id, run);
    for (const [id, old] of this.runs)
      if (
        this.runs.size > 20 &&
        !old.state.running &&
        id !== packet.source_execution_id
      )
        this.runs.delete(id);
    void this.perform(run);
    return structuredClone(run.state);
  }
  private async journal(
    run: Run,
    phase: ExecutionCheckpoint['phase'],
    ref: ScanRef,
    row: ExecutionFieldResult | null = null,
    final = false,
  ) {
    const request: ExecutionCheckpoint = {
      schema_version: 1,
      client_request_id:
        run.packet.execution_id + '-' + (run.state.sequence + 1),
      task_id: run.packet.task_id,
      execution_id: run.packet.execution_id,
      execution_epoch: run.packet.execution_epoch,
      lease_token: run.packet.lease_token,
      sequence: run.state.sequence + 1,
      phase,
      observed_snapshot_ref: ref,
      field_result: row,
      report: final ? structuredClone(run.state.report) : null,
      written_field_ids: [...run.state.written_field_ids],
    };
    let response: ExecutionView;
    try {
      response = await this.checkpoint(request);
    } catch {
      throw new ScannerFault('EXECUTION_INTERRUPTED');
    }
    if (
      response.packet.execution_id !== run.packet.execution_id ||
      response.sequence !== request.sequence
    )
      throw new ScannerFault('REVISION_CONFLICT');
    run.state.sequence = response.sequence;
    if (response.cancelled) run.cancelled = true;
  }
  private validateControl(
    controls: HTMLElement[],
    target: FieldValue,
    restoring = false,
  ) {
    if (
      controls.some(
        (c) =>
          !(
            c instanceof HTMLInputElement ||
            c instanceof HTMLTextAreaElement ||
            c instanceof HTMLSelectElement
          ),
      )
    )
      throw new ScannerFault('CONTROL_UNSUPPORTED');
    if (
      controls.some(
        (c) =>
          c.matches(':disabled') ||
          c.hasAttribute('readonly') ||
          c.getAttribute('aria-disabled') === 'true',
      )
    )
      throw new ScannerFault('CONTROL_UNSUPPORTED');
    const first = controls[0]!;
    if (
      first instanceof HTMLInputElement &&
      ([
        'password',
        'hidden',
        'file',
        'submit',
        'button',
        'reset',
        'image',
      ].includes(first.type) ||
        !/^(text|email|tel|date|month|radio|checkbox)$/.test(first.type))
    )
      throw new ScannerFault('CONTROL_UNSUPPORTED');
    if (first instanceof HTMLInputElement && first.type === 'checkbox') {
      if (typeof target !== 'boolean') throw new ScannerFault('RULE_VIOLATION');
    } else if (first instanceof HTMLInputElement && first.type === 'radio') {
      if (
        target !== null &&
        (typeof target !== 'string' ||
          controls.filter(
            (c) =>
              (c as HTMLInputElement).value === target &&
              !c.matches(':disabled'),
          ).length !== 1)
      )
        throw new ScannerFault('RULE_VIOLATION');
    } else if (first instanceof HTMLSelectElement) {
      const values = Array.isArray(target) ? target : [target];
      if (
        (first.multiple
          ? !Array.isArray(target)
          : typeof target !== 'string') ||
        values.some(
          (v) =>
            typeof v !== 'string' ||
            Array.from(first.options).filter(
              (o) =>
                o.value === v &&
                (restoring ||
                  (!o.disabled &&
                    !o.hidden &&
                    !(
                      o.parentElement instanceof HTMLOptGroupElement &&
                      o.parentElement.disabled
                    ))),
            ).length !== 1,
        )
      )
        throw new ScannerFault('RULE_VIOLATION');
    } else if (typeof target !== 'string')
      throw new ScannerFault('RULE_VIOLATION');
  }
  private write(
    controls: HTMLElement[],
    target: FieldValue,
    restoring = false,
  ) {
    this.validateControl(controls, target, restoring);
    controls.forEach((c) => this.self.add(c));
    try {
      const first = controls[0]!;
      let emit = first;
      if (first instanceof HTMLInputElement && first.type === 'radio') {
        for (const c of controls) {
          const input = c as HTMLInputElement;
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'checked',
          )!.set!.call(input, input.value === target);
          if (input.value === target) emit = input;
        }
      } else if (first instanceof HTMLInputElement && first.type === 'checkbox')
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'checked',
        )!.set!.call(first, target);
      else if (first instanceof HTMLSelectElement) {
        if (first.multiple)
          for (const option of Array.from(first.options))
            Object.getOwnPropertyDescriptor(
              HTMLOptionElement.prototype,
              'selected',
            )!.set!.call(option, (target as string[]).includes(option.value));
        else
          Object.getOwnPropertyDescriptor(
            HTMLSelectElement.prototype,
            'value',
          )!.set!.call(first, target);
      } else if (first instanceof HTMLTextAreaElement)
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )!.set!.call(first, target);
      else
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!.call(first, target);
      emit.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      emit.dispatchEvent(
        new Event('change', { bubbles: true, composed: true }),
      );
    } finally {
      controls.forEach((c) => this.self.delete(c));
    }
  }
  private valid(controls: HTMLElement[]) {
    return controls.every(
      (c) =>
        !c.matches('[aria-invalid="true"]') &&
        (!(
          c instanceof HTMLInputElement ||
          c instanceof HTMLTextAreaElement ||
          c instanceof HTMLSelectElement
        ) ||
          c.validity.valid) &&
        !c.closest('[aria-invalid="true"]'),
    );
  }
  private async read(run: Run, id: string) {
    if (this.scanner.annotationRevision !== run.annotationRevision)
      throw new ScannerFault('PAGE_CHANGED');
    const data = await this.scanner.executionField(run.packet.snapshot_ref, id);
    return { ...data, value: data.field.current_value };
  }
  private async field(
    run: Run,
    item: ExecutionPacket['items'][number],
  ): Promise<{ row: ExecutionFieldResult; ref: ScanRef }> {
    this.check(run);
    let data = await this.read(run, item.field.field_id),
      ref = snapshotRef(data.snapshot),
      row = this.failRow(item, 'EXECUTION_INTERRUPTED', item.before);
    const source = run.packet.source_execution_id
      ? this.runs.get(run.packet.source_execution_id)
      : null;
    const edited =
      source &&
      source.editVersions.get(item.field.field_id) !==
        (this.edits.get(item.field.field_id) ?? 0);
    const editAtRead = this.edits.get(item.field.field_id) ?? 0;
    const protect = edited || !equal(data.value, item.before);
    await this.journal(run, 'before', ref, row);
    run.prepared.add(item.field.field_id);
    this.check(run);
    data = await this.read(run, item.field.field_id);
    ref = snapshotRef(data.snapshot);
    if (
      protect ||
      (this.edits.get(item.field.field_id) ?? 0) !== editAtRead ||
      (source &&
        source.editVersions.get(item.field.field_id) !==
          (this.edits.get(item.field.field_id) ?? 0)) ||
      !equal(data.value, item.before)
    )
      row = this.failRow(item, 'USER_CHANGED', data.value);
    else {
      this.check(run);
      const version = this.edits.get(item.field.field_id) ?? 0;
      run.editVersions.set(item.field.field_id, version);
      this.write(data.controls, item.target, run.packet.action === 'undo');
      run.state.written_field_ids.push(item.field.field_id);
      const verifyStart = performance.now();
      const end = verifyStart + STABLE_WINDOW_MS;
      let reason: ErrorCode | null = null,
        actual: FieldValue = null;
      do {
        await pause(SAMPLE_MS);
        this.check(run);
        const read = await this.read(run, item.field.field_id);
        actual = read.value;
        ref = snapshotRef(read.snapshot);
        if (performance.now() - verifyStart > VERIFY_TIMEOUT_MS)
          reason = 'VALUE_NOT_PERSISTED';
        if (!equal(actual, item.target)) reason = 'VALUE_NOT_PERSISTED';
        else if (run.packet.action !== 'undo' && !this.valid(read.controls))
          reason = 'SITE_VALIDATION_FAILED';
        if ((this.edits.get(item.field.field_id) ?? 0) !== version)
          reason = 'USER_CHANGED';
      } while (performance.now() < end);
      row = {
        field_id: item.field.field_id,
        before: item.before,
        target: item.target,
        actual,
        status: reason ? 'failed' : 'verified',
        error_code: reason,
      };
    }
    await this.journal(run, 'after', ref, row);
    return { row, ref };
  }
  private async perform(run: Run) {
    let lastRef = run.packet.observed_snapshot_ref,
      interrupted = false;
    try {
      for (const item of run.packet.items) {
        const result = await this.field(run, item);
        run.state.report.field_results.push(result.row);
        lastRef = result.ref;
      }
    } catch (error) {
      run.state.last_error = code(error);
      interrupted = true;
    }
    // Read every attempted field again after dependent page scripts have run.
    for (const row of run.state.report.field_results) {
      if (row.status !== 'verified') continue;
      try {
        const data = await this.read(run, row.field_id);
        lastRef = snapshotRef(data.snapshot);
        if (
          (this.edits.get(row.field_id) ?? 0) !==
          run.editVersions.get(row.field_id)
        ) {
          row.status = 'failed';
          row.error_code = 'USER_CHANGED';
          row.actual = data.value;
        } else if (!equal(data.value, row.target)) {
          row.status = 'failed';
          row.error_code = 'VALUE_NOT_PERSISTED';
          row.actual = data.value;
        } else if (run.packet.action !== 'undo' && !this.valid(data.controls)) {
          row.status = 'failed';
          row.error_code = 'SITE_VALIDATION_FAILED';
        }
      } catch (error) {
        row.status = 'failed';
        row.error_code = code(error);
        row.actual = null;
        interrupted = true;
      }
    }
    for (const item of run.packet.items)
      if (
        !run.state.report.field_results.some(
          (r) => r.field_id === item.field.field_id,
        )
      ) {
        let actual: FieldValue = null;
        try {
          actual = (await this.read(run, item.field.field_id)).value;
        } catch {
          /* Lost page, actual unknown. */
        }
        run.state.report.field_results.push(
          this.failRow(
            item,
            (run.state.last_error as ErrorCode | null) ??
              'EXECUTION_INTERRUPTED',
            actual,
          ),
        );
      }
    run.state.report.ended_at = Date.now();
    try {
      await this.journal(
        run,
        interrupted ? 'interrupted' : 'completed',
        lastRef,
        null,
        true,
      );
    } catch {
      run.state.last_error = 'EXECUTION_INTERRUPTED';
    }
    run.state.running = false;
    if (this.active === run) this.active = null;
  }
  state(id: string) {
    const run = this.runs.get(id);
    if (!run) throw new ScannerFault('REFERENCE_NOT_FOUND');
    return structuredClone(run.state);
  }
  cancel(id: string) {
    const run = this.runs.get(id);
    if (run) run.cancelled = true;
    return run ? structuredClone(run.state) : null;
  }
  stop() {
    this.stopped = true;
    for (const run of this.runs.values()) run.cancelled = true;
    document.removeEventListener('input', this.onEdit, true);
    document.removeEventListener('change', this.onEdit, true);
    document.removeEventListener('beforeinput', this.onEdit, true);
  }
}
