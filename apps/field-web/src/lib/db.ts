import type { ReportInput } from "@floodrise/contracts";
import Dexie, { type EntityTable } from "dexie";

export const QUEUE_LIMIT_ITEMS = 100;
export const QUEUE_LIMIT_BYTES = 100 * 1024 * 1024;
export const QUEUE_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const QUEUE_CHANGED_EVENT = "floodrise:queue-changed";
export const QUEUE_ENQUEUED_EVENT = "floodrise:queue-enqueued";

export type PhotoDraft = {
  name: string;
  type: string;
  dataUrl: string;
};

export type OfflineReportDraft = ReportInput & {
  place_label: string;
  photo?: PhotoDraft;
};

export type QueueState = "QUEUED" | "SYNCING" | "RETRY" | "NEEDS_ACTION";

export type EncryptedQueueRecord = {
  id: string;
  createdAt: number;
  expiresAt: number;
  sizeBytes: number;
  state: QueueState;
  attempts: number;
  nextAttemptAt?: number;
  iv: string;
  ciphertext: string;
  lastError?: string;
};

type DeviceKeyRecord = {
  id: "field-queue-v1";
  key: CryptoKey;
};

export type ReportReceipt = {
  id: string;
  clientReportId: string;
  reference: string;
  receivedAt: string;
  placeLabel: string;
  status: "RECEIVED" | "UNDER_REVIEW" | "COMMUNITY_CORROBORATED";
  source: "API" | "DEMO";
  message: string;
};

class FieldDatabase extends Dexie {
  queue!: EntityTable<EncryptedQueueRecord, "id">;
  keys!: EntityTable<DeviceKeyRecord, "id">;
  receipts!: EntityTable<ReportReceipt, "id">;

  constructor() {
    super("floodrise-field-v1");
    this.version(1).stores({
      queue: "&id, createdAt, expiresAt, state",
      keys: "&id",
      receipts: "&id, clientReportId, receivedAt"
    });
  }
}

export const fieldDb = new FieldDatabase();

function announceQueueChange() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(QUEUE_CHANGED_EVENT));
}

async function getOrCreateDeviceKey() {
  const stored = await fieldDb.keys.get("field-queue-v1");
  if (stored) return stored.key;

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await fieldDb.keys.put({ id: "field-queue-v1", key });
  return key;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptDraft(draft: OfflineReportDraft) {
  const key = await getOrCreateDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(draft));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded)
  );
  const ciphertext = bytesToBase64(encrypted);
  const encodedIv = bytesToBase64(iv);
  return { iv: encodedIv, ciphertext, sizeBytes: ciphertext.length + encodedIv.length };
}

export async function decryptQueueRecord(record: EncryptedQueueRecord) {
  const key = await getOrCreateDeviceKey();
  const iv = base64ToBytes(record.iv);
  const ciphertext = base64ToBytes(record.ciphertext);
  const decoded = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(decoded)) as OfflineReportDraft;
}

export class QueueCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueCapacityError";
  }
}

export async function purgeExpiredReports(now = Date.now()) {
  const expired = await fieldDb.queue.where("expiresAt").belowOrEqual(now).primaryKeys();
  if (expired.length) {
    await fieldDb.queue.bulkDelete(expired);
    announceQueueChange();
  }
  return expired.length;
}

export async function enqueueReport(
  draft: OfflineReportDraft,
  now = Date.now(),
  retry?: { nextAttemptAt: number; lastError: string }
) {
  await purgeExpiredReports(now);
  const [queued, encrypted] = await Promise.all([fieldDb.queue.toArray(), encryptDraft(draft)]);
  const totalBytes = queued.reduce((sum, item) => sum + item.sizeBytes, 0);
  if (queued.length >= QUEUE_LIMIT_ITEMS) {
    throw new QueueCapacityError("Offline queue is full. Reconnect and sync or remove an older report.");
  }
  if (totalBytes + encrypted.sizeBytes > QUEUE_LIMIT_BYTES) {
    throw new QueueCapacityError("Offline evidence storage reached 100 MB. Reconnect and sync or remove an older report.");
  }

  const record: EncryptedQueueRecord = {
    id: draft.client_report_id,
    createdAt: now,
    expiresAt: now + QUEUE_EXPIRY_MS,
    sizeBytes: encrypted.sizeBytes,
    state: retry ? "RETRY" : "QUEUED",
    attempts: 0,
    nextAttemptAt: retry?.nextAttemptAt,
    lastError: retry?.lastError,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext
  };
  await fieldDb.queue.add(record);
  announceQueueChange();
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(QUEUE_ENQUEUED_EVENT));
  return record;
}

export async function listQueuedReports() {
  await purgeExpiredReports();
  const records = await fieldDb.queue.orderBy("createdAt").reverse().toArray();
  return Promise.all(
    records.map(async (record) => ({
      record,
      draft: await decryptQueueRecord(record)
    }))
  );
}

export async function getQueueSummary() {
  await purgeExpiredReports();
  const records = await fieldDb.queue.toArray();
  return {
    count: records.length,
    bytes: records.reduce((sum, item) => sum + item.sizeBytes, 0),
    oldestCreatedAt: records.length ? Math.min(...records.map((item) => item.createdAt)) : null
  };
}

export async function updateQueueState(
  id: string,
  state: QueueState,
  lastError?: string,
  nextAttemptAt?: number
) {
  const current = await fieldDb.queue.get(id);
  if (!current) return;
  await fieldDb.queue.update(id, {
    state,
    attempts: state === "SYNCING" ? current.attempts + 1 : current.attempts,
    lastError,
    nextAttemptAt
  });
  announceQueueChange();
}

export async function deleteQueuedReport(id: string) {
  await fieldDb.queue.delete(id);
  announceQueueChange();
}

export async function saveReceipt(receipt: ReportReceipt) {
  await fieldDb.receipts.put(receipt);
}

export async function getReceipt(id: string) {
  return fieldDb.receipts.get(id);
}

/**
 * Clear persistent evidence owned by this Field PWA origin.
 *
 * Callers must first prove that the connected API is in demo mode and require
 * an explicit user action. Keeping that policy outside this storage primitive
 * makes the deletion boundary straightforward to test while preventing a URL
 * visit from silently erasing a reporter's drafts.
 */
export async function clearDemoFieldData() {
  const [queuedDrafts, receipts] = await Promise.all([
    fieldDb.queue.count(),
    fieldDb.receipts.count()
  ]);

  await fieldDb.transaction("rw", fieldDb.queue, fieldDb.keys, fieldDb.receipts, async () => {
    await Promise.all([
      fieldDb.queue.clear(),
      fieldDb.keys.clear(),
      fieldDb.receipts.clear()
    ]);
  });
  announceQueueChange();
  return { queuedDrafts, receipts };
}

export async function clearFieldDatabaseForTests() {
  await fieldDb.delete();
  await fieldDb.open();
}
