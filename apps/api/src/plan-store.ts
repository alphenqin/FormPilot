import { DatabaseSync } from 'node:sqlite';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHmac,
} from 'node:crypto';
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FillPlanView, ExecutionView } from '@formpilot/contracts';
import type { PlanningContext } from '@formpilot/domain';
export interface StoredPlan {
  context: PlanningContext;
  view: FillPlanView;
  history: FillPlanView[];
  executions?: ExecutionView[];
  execution_epoch?: number;
}
export class PlanStore {
  private db: DatabaseSync;
  constructor(
    private key: Buffer,
    path = ':memory:',
  ) {
    if (key.length !== 32) throw new Error('STORAGE_UNAVAILABLE');
    if (path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    const version = this.db.prepare('PRAGMA user_version').get();
    if (Number(version?.user_version ?? 0) > 2) {
      this.db.close();
      throw new Error('STORAGE_UNAVAILABLE');
    }
    if (Number(version?.user_version ?? 0) === 0)
      this.db.exec(
        readFileSync(
          new URL('../migrations/0001_plans.sql', import.meta.url),
          'utf8',
        ),
      );
    this.db.exec(
      readFileSync(
        new URL('../migrations/0002_execution_locks.sql', import.meta.url),
        'utf8',
      ),
    );
  }
  private tag(value: string) {
    return createHmac('sha256', this.key).update(value).digest('hex');
  }
  private seal(value: unknown, aad: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }
  private open<T>(raw: Uint8Array, aad: string): T {
    const bytes = Buffer.from(raw),
      cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        cipher.update(bytes.subarray(28)),
        cipher.final(),
      ]).toString(),
    );
  }
  get(owner: string, task: string): StoredPlan | null {
    const scope = this.tag(owner),
      id = this.tag(task);
    const row = this.db
      .prepare('SELECT payload, expires FROM plans WHERE owner=? AND task=?')
      .get(scope, id);
    if (!row || Number(row.expires) < Date.now()) return null;
    return this.open(row.payload as Uint8Array, scope + id);
  }
  reserve<T = FillPlanView>(owner: string, id: string, hash: string) {
    const scope = this.tag(owner),
      key = this.tag(id);
    this.sweep();
    const row = this.db
      .prepare('SELECT hash,payload FROM operations WHERE owner=? AND id=?')
      .get(scope, key);
    if (row) {
      if (row.hash !== hash) throw new Error('IDEMPOTENCY_CONFLICT');
      if (!row.payload) throw new Error('TASK_INTERRUPTED');
      return this.open<T>(row.payload as Uint8Array, scope + key);
    }
    const count = this.db
      .prepare('SELECT count(*) AS n FROM operations')
      .get()!;
    if (Number(count.n) >= 5000) throw new Error('RATE_LIMITED');
    this.db
      .prepare('INSERT INTO operations VALUES(?,?,?,?,NULL)')
      .run(scope, key, hash, Date.now() + 86400000);
    return null;
  }
  put(
    owner: string,
    task: string,
    expected: number,
    record: StoredPlan,
    operation: string,
    response: unknown = record.view,
    lock?:
      | { acquire: { execution_id: string; expires_at: number } }
      | { release: string },
  ) {
    const scope = this.tag(owner),
      id = this.tag(task),
      op = this.tag(operation);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT revision FROM plans WHERE owner=? AND task=?')
        .get(scope, id);
      if (Number(row?.revision ?? 0) !== expected)
        throw new Error('REVISION_CONFLICT');
      if (lock && 'acquire' in lock) {
        const held = this.db
          .prepare(
            'SELECT execution,expires FROM execution_locks WHERE owner=?',
          )
          .get(scope);
        if (held && Number(held.expires) > Date.now())
          throw new Error('EXECUTION_LOCKED');
        this.db
          .prepare(
            'INSERT INTO execution_locks VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET execution=excluded.execution,expires=excluded.expires',
          )
          .run(
            scope,
            this.tag(lock.acquire.execution_id),
            lock.acquire.expires_at,
          );
      } else if (lock && 'release' in lock) {
        this.db
          .prepare('DELETE FROM execution_locks WHERE owner=? AND execution=?')
          .run(scope, this.tag(lock.release));
      }
      this.db
        .prepare(
          'INSERT INTO plans VALUES(?,?,?,?,?) ON CONFLICT(owner,task) DO UPDATE SET revision=excluded.revision,expires=excluded.expires,payload=excluded.payload',
        )
        .run(
          scope,
          id,
          record.view.state_revision,
          record.view.expires_at,
          this.seal(record, scope + id),
        );
      this.db
        .prepare('UPDATE operations SET payload=? WHERE owner=? AND id=?')
        .run(this.seal(response, scope + op), scope, op);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  forget(owner: string) {
    const scope = this.tag(owner);
    this.db.prepare('DELETE FROM execution_locks WHERE owner=?').run(scope);
    this.db.prepare('DELETE FROM plans WHERE owner=?').run(scope);
    this.db.prepare('DELETE FROM operations WHERE owner=?').run(scope);
  }
  sweep() {
    this.db
      .prepare('DELETE FROM execution_locks WHERE expires<?')
      .run(Date.now());
    this.db.prepare('DELETE FROM plans WHERE expires<?').run(Date.now());
    this.db.prepare('DELETE FROM operations WHERE expires<?').run(Date.now());
  }
  close() {
    this.db.close();
  }
}
