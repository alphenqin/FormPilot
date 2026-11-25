import { expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { FormExecutor, FormScanner } from '@formpilot/browser-engine';
import type {
  ExecutionPacket,
  ExecutionView,
  ExecutionCheckpoint,
  FieldValue,
  FormSnapshot,
  BrowserExecutionState,
} from '@formpilot/contracts';
declare global {
  interface Window {
    scenario: string;
    __m4scanner: FormScanner;
    __m4executor: FormExecutor;
    __m4packets: Record<string, ExecutionPacket>;
    __m4views: Record<string, ExecutionView>;
    __m4journal: ExecutionCheckpoint[];
    __m4guard: boolean;
    __m4beforeDelay: number;
    __m4timings: { field_id: string; phase: string; at_ms: number }[];
  }
}
export async function initializeExecution(
  page: Page,
  scenario = '',
  template = 'execution.html',
) {
  await page.goto(
    'http://127.0.0.1:3000/m2-fixtures/' +
      template +
      (scenario ? '?scenario=' + scenario : ''),
  );
  await page.evaluate(
    async (path) => {
      const { FormScanner, FormExecutor } = await import(path);
      window.__m4scanner = new FormScanner({
        task_id: crypto.randomUUID(),
        tab_id: 100,
        started_at: Date.now(),
        expires_at: Date.now() + 600000,
      });
      window.__m4packets = {};
      window.__m4views = {};
      window.__m4journal = [];
      window.__m4guard = true;
      window.__m4beforeDelay = 0;
      window.__m4timings = [];
      window.__m4executor = new FormExecutor(
        window.__m4scanner,
        async (request: ExecutionCheckpoint) => {
          if (request.phase === 'before' && !window.__m4guard)
            throw new Error('profile guard failed');
          window.__m4journal.push(structuredClone(request));
          if (request.field_result)
            window.__m4timings.push({
              field_id: request.field_result.field_id,
              phase: request.phase,
              at_ms: performance.now(),
            });
          if (request.phase === 'before' && window.__m4beforeDelay)
            await new Promise((r) => setTimeout(r, window.__m4beforeDelay));
          const packet = window.__m4packets[request.execution_id]!,
            old = window.__m4views[request.execution_id]!;
          const view: ExecutionView = {
            ...old,
            packet,
            sequence: request.sequence,
            phase: request.phase,
            pending_field_id:
              request.phase === 'before'
                ? request.field_result!.field_id
                : null,
            written_field_ids: request.written_field_ids,
            report: request.report ?? {
              ...old.report,
              field_results: request.field_result
                ? [
                    ...old.report.field_results.filter(
                      (f) => f.field_id !== request.field_result!.field_id,
                    ),
                    request.field_result,
                  ]
                : old.report.field_results,
            },
          };
          window.__m4views[packet.execution_id] = view;
          return view;
        },
      );
    },
    '/@fs' + resolve('packages/browser-engine/src/index.ts'),
  );
}
export async function packetFor(
  page: Page,
  targets: Record<string, FieldValue>,
  options: {
    action?: ExecutionPacket['action'];
    source_execution_id?: string;
    epoch?: number;
    before?: Record<string, FieldValue>;
  } = {},
): Promise<ExecutionPacket> {
  return page.evaluate(
    async ({ targets, options }) => {
      const snapshot = await window.__m4scanner.scan(),
        ref = {
          task_id: snapshot.task_id,
          tab_id: snapshot.tab_id,
          frame_id: 0 as const,
          page_instance_id: snapshot.page_instance_id,
          form_snapshot_id: snapshot.form_snapshot_id,
          dom_fingerprint: snapshot.dom_fingerprint,
        };
      const packet: ExecutionPacket = {
        execution_id: crypto.randomUUID(),
        execution_epoch: options.epoch ?? 1,
        lease_token: 'b'.repeat(64),
        task_id: snapshot.task_id,
        plan_id: 'browser-plan',
        plan_revision: 1,
        plan_digest: 'a'.repeat(64),
        profile_revision: 1,
        snapshot_ref: ref,
        observed_snapshot_ref: ref,
        action: options.action ?? 'fill',
        source_execution_id: options.source_execution_id ?? null,
        expires_at: Date.now() + 600000,
        items: Object.entries(targets).map(([id, target]) => {
          const field = snapshot.fields.find(
            (f) => f.html_id === id || f.name === id,
          );
          if (!field) throw new Error('missing fixture field ' + id);
          return {
            field,
            before: options.before?.[id] ?? field.current_value,
            target,
            restore: field.current_value,
          };
        }),
      };
      window.__m4packets[packet.execution_id] = packet;
      const now = Date.now();
      window.__m4views[packet.execution_id] = {
        packet,
        sequence: 0,
        phase: 'created',
        pending_field_id: null,
        report: {
          execution_id: packet.execution_id,
          started_at: now,
          ended_at: now,
          field_results: [],
        },
        written_field_ids: [],
        cancelled: false,
      };
      return packet;
    },
    { targets, options },
  );
}
export async function runPacket(page: Page, packet: ExecutionPacket) {
  await page.evaluate(async (packet) => {
    await window.__m4executor.start(
      packet,
      window.__m4views[packet.execution_id]!.report.started_at,
    );
  }, packet);
}
export async function finished(
  page: Page,
  id: string,
): Promise<BrowserExecutionState> {
  await expect
    .poll(
      async () =>
        page.evaluate((id) => window.__m4executor.state(id).running, id),
      { timeout: 20000 },
    )
    .toBe(false);
  return page.evaluate((id) => window.__m4executor.state(id), id);
}
export async function undoPacket(
  page: Page,
  source: ExecutionPacket,
  epoch = 2,
) {
  const snapshot = (await page.evaluate(() =>
    window.__m4scanner.scan(),
  )) as FormSnapshot;
  return page.evaluate(
    ({ source, snapshot, epoch }) => {
      const packet: ExecutionPacket = {
        ...source,
        execution_id: crypto.randomUUID(),
        execution_epoch: epoch,
        action: 'undo',
        source_execution_id: source.execution_id,
        observed_snapshot_ref: {
          task_id: snapshot.task_id,
          tab_id: snapshot.tab_id,
          frame_id: 0,
          page_instance_id: snapshot.page_instance_id,
          form_snapshot_id: snapshot.form_snapshot_id,
          dom_fingerprint: snapshot.dom_fingerprint,
        },
        items: source.items.map((item) => ({
          ...item,
          before: item.target,
          target: item.restore,
        })),
      };
      window.__m4packets[packet.execution_id] = packet;
      const now = Date.now();
      window.__m4views[packet.execution_id] = {
        packet,
        sequence: 0,
        phase: 'created',
        pending_field_id: null,
        report: {
          execution_id: packet.execution_id,
          started_at: now,
          ended_at: now,
          field_results: [],
        },
        written_field_ids: [],
        cancelled: false,
      };
      return packet;
    },
    { source, snapshot, epoch },
  );
}
