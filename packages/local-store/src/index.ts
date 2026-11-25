import {
  LocalFillTaskSchema,
  type LocalFillTask,
  type CareerState,
} from '@formpilot/contracts';
import { Value } from '@sinclair/typebox/value';
import Dexie, { type EntityTable } from 'dexie';
import {
  emptyProfile,
  type ProfileState,
  currentFacts,
  validateFactValue,
  validateCareerState,
  emptyCareer,
  validateResumeGrounding,
  validateAnswerSnapshots,
} from '@formpilot/domain';
export const VAULT_SCHEMA_VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 16384)
    out += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(out);
}
export function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
export async function hashText(text: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(text)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
interface Cipher {
  iv: string;
  ciphertext: string;
}
export interface VaultRecord {
  id: 'workspace';
  format: 'formpilot-vault';
  schema_version: 1;
  workspace_id: string;
  revision: number;
  iterations: number;
  salt: string;
  wrapped_key: Cipher;
  payload: Cipher;
}
class VaultDatabase extends Dexie {
  records!: EntityTable<VaultRecord, 'id'>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({ records: 'id' });
  }
}
async function derivedKey(password: string, salt: string, iterations: number) {
  if (password.length < 10) throw new Error('口令至少 10 位');
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(salt), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
async function seal(
  key: CryptoKey,
  bytes: Uint8Array<ArrayBuffer>,
  aad: string,
): Promise<Cipher> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
    key,
    bytes,
  );
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}
async function unseal(key: CryptoKey, cipher: Cipher, aad: string) {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64(cipher.iv),
        additionalData: encoder.encode(aad),
      },
      key,
      fromBase64(cipher.ciphertext),
    ),
  );
}
const keyAad = (record: Pick<VaultRecord, 'workspace_id' | 'schema_version'>) =>
  'formpilot:key:' + record.workspace_id + ':' + record.schema_version;
const dataAad = (
  record: Pick<VaultRecord, 'workspace_id' | 'schema_version' | 'revision'>,
) =>
  'formpilot:data:' +
  record.workspace_id +
  ':' +
  record.schema_version +
  ':' +
  record.revision;
function validateRecord(input: unknown): VaultRecord {
  if (!input || typeof input !== 'object') throw new Error('备份格式无效');
  const r = input as Partial<VaultRecord>;
  if (
    Object.keys(r).some(
      (key) =>
        ![
          'id',
          'format',
          'schema_version',
          'workspace_id',
          'revision',
          'iterations',
          'salt',
          'wrapped_key',
          'payload',
        ].includes(key),
    )
  )
    throw new Error('备份元数据包含未知字段');
  if (
    r.format !== 'formpilot-vault' ||
    r.schema_version !== 1 ||
    r.id !== 'workspace' ||
    typeof r.workspace_id !== 'string' ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(r.workspace_id) ||
    !Number.isSafeInteger(r.revision) ||
    r.revision! < 1 ||
    typeof r.iterations !== 'number' ||
    !Number.isSafeInteger(r.iterations) ||
    r.iterations < 600000 ||
    r.iterations > 2000000 ||
    typeof r.salt !== 'string'
  )
    throw new Error('备份版本不受支持或加密参数无效');
  for (const c of [r.wrapped_key, r.payload]) {
    if (
      !c ||
      typeof c.iv !== 'string' ||
      typeof c.ciphertext !== 'string' ||
      fromBase64(c.iv).length !== 12 ||
      c.ciphertext.length > 80000000
    )
      throw new Error('备份密文无效');
  }
  if (fromBase64(r.salt).length !== 16) throw new Error('备份 salt 无效');
  return r as VaultRecord;
}
export function validateState(input: unknown): ProfileState {
  const p = input as ProfileState;
  if (
    !p ||
    p.schema_version !== 1 ||
    typeof p.workspace_id !== 'string' ||
    !Number.isSafeInteger(p.profile_revision) ||
    p.profile_revision < 0 ||
    !Array.isArray(p.documents) ||
    !Array.isArray(p.facts) ||
    !Array.isArray(p.evidences) ||
    !Array.isArray(p.entities) ||
    !Array.isArray(p.measurements)
  )
    throw new Error('资料格式或版本不受支持');
  if (
    p.fill_tasks !== undefined &&
    (!Array.isArray(p.fill_tasks) ||
      p.fill_tasks.length > 30 ||
      p.fill_tasks.some((t) => !Value.Check(LocalFillTaskSchema, t)))
  )
    throw new Error('填写计划格式无效');
  if (p.career !== undefined) validateCareerState(p.career);
  const ids = (values: string[]) =>
    values.every((v) => typeof v === 'string') &&
    new Set(values).size === values.length;
  if (
    !ids(p.documents.map((d) => d.document_id)) ||
    !ids(p.entities.map((e) => e.entity_id)) ||
    !ids(p.evidences.map((e) => e.evidence_id))
  )
    throw new Error('资料引用重复');
  for (const d of p.documents) {
    if (
      !Array.isArray(d.blocks) ||
      d.blocks.some(
        (b) =>
          b.document_id !== d.document_id ||
          b.document_revision !== 1 ||
          typeof b.text !== 'string' ||
          b.end - b.start !== b.text.length,
      )
    )
      throw new Error('文档分块无效');
  }
  for (const e of p.evidences) {
    const block = p.documents
      .find((d) => d.document_id === e.document_id)
      ?.blocks.find((b) => b.block_id === e.block_id);
    if (!block || block.text.slice(e.start, e.end) !== e.quote)
      throw new Error('证据引用无效');
  }
  const versions = new Set<string>();
  for (const f of p.facts) {
    validateFactValue(f.path, f.value);
    if (
      !p.entities.some(
        (e) => e.entity_id === f.entity_id && e.category === f.category,
      ) ||
      !Array.isArray(f.evidence_ids) ||
      !f.evidence_ids.every((id) =>
        p.evidences.some((e) => e.evidence_id === id),
      ) ||
      !['pending', 'confirmed', 'rejected'].includes(f.confirmation) ||
      !['resume', 'user'].includes(f.source_type) ||
      f.profile_revision > p.profile_revision ||
      !Number.isSafeInteger(f.fact_revision) ||
      f.fact_revision < 1
    )
      throw new Error('事实引用无效');
    const key = f.fact_id + ':' + f.fact_revision;
    if (versions.has(key)) throw new Error('事实版本重复');
    versions.add(key);
  }
  for (const resume of p.career?.resumes ?? [])
    validateResumeGrounding(resume, p);
  for (const a of p.career?.answers ?? [])
    validateAnswerSnapshots(a.input, a.facts, p);
  for (const a of p.career?.answer_pending ?? [])
    validateAnswerSnapshots(a.request.input, a.facts, p);
  void currentFacts(p);
  return p;
}
async function calibrate(password: string, salt: string) {
  const start = performance.now();
  await derivedKey(password, salt, 600000);
  const elapsed = Math.max(1, performance.now() - start);
  return Math.min(
    2000000,
    Math.max(600000, Math.round((600000 * 180) / elapsed)),
  );
}
export function mergeLocalTasks(
  current: LocalFillTask[] = [],
  proposed: LocalFillTask[] = [],
): LocalFillTask[] {
  const tasks = new Map(current.map((t) => [t.task_id, structuredClone(t)]));
  for (const item of proposed) {
    const previous = tasks.get(item.task_id);
    if (!previous) {
      tasks.set(item.task_id, structuredClone(item));
      continue;
    }
    const newer =
      item.latest.plan_revision > previous.latest.plan_revision ||
      (item.latest.plan_revision === previous.latest.plan_revision &&
        item.latest.state_revision >= previous.latest.state_revision);
    const winner = newer ? item : previous,
      other = newer ? previous : item;
    const executions = new Map(
      (other.executions ?? []).map((e) => [e.packet.execution_id, e]),
    );
    for (const e of winner.executions ?? []) {
      const old = executions.get(e.packet.execution_id);
      if (!old || e.sequence > old.sequence)
        executions.set(e.packet.execution_id, e);
      else if (e.sequence === old.sequence)
        executions.set(e.packet.execution_id, {
          ...e,
          cancelled: e.cancelled || old.cancelled,
          verify_result: e.verify_result ?? old.verify_result ?? null,
        });
    }
    const merged = { ...winner };
    if (executions.size)
      merged.executions = [...executions.values()]
        .sort((a, b) => a.packet.execution_epoch - b.packet.execution_epoch)
        .slice(-20);
    tasks.set(item.task_id, structuredClone(merged));
  }
  return [...tasks.values()].sort((a, b) => a.saved_at - b.saved_at).slice(-30);
}
export class Vault {
  private db: VaultDatabase;
  private key: CryptoKey | null = null;
  private record: VaultRecord | null = null;
  private epoch = 0;
  private writes: Promise<void> = Promise.resolve();
  private queued<T>(work: () => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const job = this.writes.then(() => {
      if (epoch !== this.epoch) throw new Error('资料库已锁定');
      return work();
    });
    this.writes = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
  constructor(name = 'formpilot-vault') {
    this.db = new VaultDatabase(name);
  }
  get unlocked() {
    return this.key !== null;
  }
  async exists() {
    return !!(await this.db.records.get('workspace'));
  }
  lock() {
    this.key = null;
    this.record = null;
    this.epoch++;
  }
  close() {
    this.lock();
    this.db.close();
  }
  async create(password: string) {
    const epoch = this.epoch;
    if (await this.exists()) throw new Error('资料库已存在，请解锁');
    const salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
    const iterations = await calibrate(password, salt);
    const wrap = await derivedKey(password, salt, iterations);
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
    const state = emptyProfile();
    const metadata = {
      id: 'workspace' as const,
      format: 'formpilot-vault' as const,
      schema_version: 1 as const,
      workspace_id: state.workspace_id,
      revision: 1,
      iterations,
      salt,
    };
    const wrapped_key = await seal(wrap, raw, keyAad(metadata));
    raw.fill(0);
    const record: VaultRecord = {
      ...metadata,
      wrapped_key,
      payload: await seal(
        key,
        encoder.encode(JSON.stringify(state)),
        dataAad(metadata),
      ),
    };
    if (epoch !== this.epoch) throw new Error('创建已取消');
    await this.db.records.add(record);
    if (epoch !== this.epoch) throw new Error('创建已取消');
    this.key = key;
    this.record = record;
    return state;
  }
  async unlock(password: string) {
    const epoch = this.epoch;
    const raw = await this.db.records.get('workspace');
    if (!raw) throw new Error('资料库不存在');
    const r = validateRecord(raw);
    try {
      const wrapping = await derivedKey(password, r.salt, r.iterations);
      const bytes = await unseal(wrapping, r.wrapped_key, keyAad(r));
      const key = await crypto.subtle.importKey(
        'raw',
        bytes,
        'AES-GCM',
        false,
        ['encrypt', 'decrypt'],
      );
      bytes.fill(0);
      const state = validateState(
        JSON.parse(decoder.decode(await unseal(key, r.payload, dataAad(r)))),
      );
      if (state.workspace_id !== r.workspace_id)
        throw new Error('workspace mismatch');
      if (epoch !== this.epoch) throw new Error('资料库已锁定');
      this.key = key;
      this.record = r;
      return state;
    } catch {
      throw new Error('口令错误、资料损坏或解锁已取消');
    }
  }
  readCurrent() {
    return this.queued(() => this.readUnlocked());
  }
  updateTasks(update: (tasks: LocalFillTask[]) => LocalFillTask[]) {
    return this.queued(async () => {
      const current = await this.readUnlocked();
      const next = {
        ...current,
        fill_tasks: mergeLocalTasks(
          current.fill_tasks,
          update(structuredClone(current.fill_tasks ?? [])),
        ),
      };
      if (
        JSON.stringify(current.fill_tasks ?? []) !==
        JSON.stringify(next.fill_tasks)
      )
        await this.writeState(next);
      return next;
    });
  }
  updateCareer(
    update: (state: CareerState, profile: ProfileState) => CareerState,
  ) {
    return this.queued(async () => {
      const current = await this.readUnlocked(),
        career = current.career ?? emptyCareer();
      const proposed = update(
        structuredClone(career),
        structuredClone(current),
      );
      if (JSON.stringify(proposed) === JSON.stringify(career)) return current;
      const next = {
        ...current,
        career: { ...proposed, revision: career.revision + 1 },
      };
      validateCareerState(next.career);
      await this.writeState(next);
      return next;
    });
  }
  save(state: ProfileState) {
    const proposed = structuredClone(state);
    return this.queued(async () => {
      const current = await this.readUnlocked();
      if (proposed.profile_revision < current.profile_revision)
        throw new Error('资料版本已变化，请重新读取');
      const next = { ...proposed };
      if (
        current.career &&
        (!proposed.career ||
          current.career.revision >= proposed.career.revision)
      )
        next.career = current.career;
      if (current.fill_tasks || proposed.fill_tasks)
        next.fill_tasks = mergeLocalTasks(
          current.fill_tasks,
          proposed.fill_tasks,
        );
      await this.writeState(next);
      return next;
    });
  }
  private async readUnlocked() {
    if (!this.key || !this.record) throw new Error('资料库已锁定');
    const epoch = this.epoch,
      prior = this.record,
      key = this.key;
    const raw = await this.db.records.get('workspace');
    const r = validateRecord(raw);
    if (
      r.revision !== prior.revision ||
      r.workspace_id !== prior.workspace_id ||
      r.wrapped_key.ciphertext !== prior.wrapped_key.ciphertext
    )
      throw new Error('资料被其他窗口更新，请重新解锁');
    const state = validateState(
      JSON.parse(decoder.decode(await unseal(key, r.payload, dataAad(r)))),
    );
    if (epoch !== this.epoch) throw new Error('资料库已锁定');
    return state;
  }
  private async writeState(state: ProfileState) {
    if (!this.key || !this.record) throw new Error('资料库已锁定');
    validateState(state);
    if (state.workspace_id !== this.record.workspace_id)
      throw new Error('工作空间不匹配');
    const epoch = this.epoch;
    const prior = this.record;
    const json = JSON.stringify(state);
    if (json.length > 50000000)
      throw new Error('资料库超过 50 MB 限制，请备份并清理文档');
    const updated = { ...prior, revision: prior.revision + 1 };
    const record = {
      ...updated,
      payload: await seal(this.key, encoder.encode(json), dataAad(updated)),
    };
    await this.db.transaction('rw', this.db.records, async () => {
      const existing = await this.db.records.get('workspace');
      if (epoch !== this.epoch) throw new Error('资料库已锁定');
      if (
        existing?.revision !== prior.revision ||
        existing.workspace_id !== prior.workspace_id ||
        existing.wrapped_key.ciphertext !== prior.wrapped_key.ciphertext
      )
        throw new Error('资料被其他窗口更新，请重新解锁');
      await this.db.records.put(record);
    });
    if (epoch === this.epoch) this.record = record;
  }
  async changePassword(oldPassword: string, newPassword: string) {
    if (!this.key || !this.record) throw new Error('资料库已锁定');
    const epoch = this.epoch;
    const prior = this.record;
    const old = await derivedKey(oldPassword, prior.salt, prior.iterations);
    const raw = await unseal(old, prior.wrapped_key, keyAad(prior));
    const salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
    const iterations = await calibrate(newPassword, salt);
    const wrap = await derivedKey(newPassword, salt, iterations);
    const updated = {
      ...prior,
      salt,
      iterations,
      wrapped_key: await seal(wrap, raw, keyAad(prior)),
    };
    raw.fill(0);
    await this.db.transaction('rw', this.db.records, async () => {
      const current = await this.db.records.get('workspace');
      if (
        epoch !== this.epoch ||
        current?.revision !== prior.revision ||
        current.wrapped_key.ciphertext !== prior.wrapped_key.ciphertext
      )
        throw new Error('资料库状态已变化，请重试');
      await this.db.records.put(updated);
    });
    this.record = updated;
  }
  async backup() {
    if (!this.key) throw new Error('请先解锁后导出备份');
    return JSON.stringify(await this.db.records.get('workspace'));
  }
  async restore(text: string, password: string) {
    if (await this.exists()) throw new Error('请先删除现有资料库，再恢复备份');
    if (text.length > 80000000) throw new Error('备份过大');
    const record = validateRecord(JSON.parse(text));
    const wrapping = await derivedKey(password, record.salt, record.iterations);
    const bytes = await unseal(wrapping, record.wrapped_key, keyAad(record));
    const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
    bytes.fill(0);
    const state = validateState(
      JSON.parse(
        decoder.decode(await unseal(key, record.payload, dataAad(record))),
      ),
    );
    if (state.workspace_id !== record.workspace_id)
      throw new Error('工作空间不匹配');
    await this.db.records.add(record);
    this.lock();
    return state.workspace_id;
  }
  async deleteAll() {
    this.lock();
    await this.db.records.clear();
    if (await this.exists()) throw new Error('本地删除未完成');
  }
}
