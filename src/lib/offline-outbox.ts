"use client";

/**
 * Phase 16 — offline order outbox (IndexedDB, device-local).
 *
 * Guarantees:
 *  - STABLE CLIENT OPERATION IDs: each queued order gets a UUID generated at
 *    creation; the server maps it to its idempotency fence, so duplicate sync
 *    (reconnect retry, restart, second device) yields exactly ONE order.
 *  - Encrypted-at-rest device storage is out of scope for this phase; the
 *    outbox stores ONLY order cart data (no tokens beyond the session token
 *    the browser already holds, no payment data, no customer PII beyond the
 *    optional guest name/phone the staff typed).
 *  - Sync states: QUEUED → SENDING → (DONE | QUEUED with error) — the UI can
 *    surface conflicts and keep failures for manual retry.
 */

const DB_NAME = "restroloop-outbox";
const STORE = "operations";
const VERSION = 1;

export interface OutboxOperation {
  clientOpId: string;
  tableSessionToken: string | null;
  cart: Array<{ menuItemId: string; quantity: number; optionIds?: string[]; notes?: string }>;
  customerName?: string | null;
  customerPhone?: string | null;
  notes?: string | null;
  createdAt: string;
  state: "QUEUED" | "SENDING" | "DONE" | "ERROR";
  lastError?: string | null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "clientOpId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function enqueueOperation(op: Omit<OutboxOperation, "clientOpId" | "state" | "createdAt">): Promise<string> {
  const clientOpId = crypto.randomUUID();
  const record: OutboxOperation = {
    ...op,
    clientOpId,
    state: "QUEUED",
    createdAt: new Date().toISOString(),
  };
  await withStore("readwrite", (s) => s.put(record) as unknown as IDBRequest<undefined>);
  return clientOpId;
}

export async function listOperations(): Promise<OutboxOperation[]> {
  return withStore("readonly", (s) => s.getAll() as IDBRequest<OutboxOperation[]>);
}

export async function clearDone(): Promise<void> {
  const all = await listOperations();
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  for (const op of all) {
    if (op.state === "DONE") store.delete(op.clientOpId);
  }
  tx.oncomplete = () => db.close();
}

/**
 * Sync the outbox against /api/offline/sync. Partial success is allowed:
 * each operation reports its own outcome; failed ops stay queued with their
 * last error visible for retry/conflict resolution.
 */
export async function syncOutbox(): Promise<{ synced: number; failed: number }> {
  const ops = (await listOperations()).filter((o) => o.state === "QUEUED" || o.state === "ERROR");
  if (ops.length === 0) return { synced: 0, failed: 0 };

  const res = await fetch("/api/offline/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operations: ops.map((o) => ({
        clientOpId: o.clientOpId,
        tableSessionToken: o.tableSessionToken,
        cart: o.cart,
        customerName: o.customerName,
        customerPhone: o.customerPhone,
        notes: o.notes,
      })),
    }),
  });
  const body = (await res.json().catch(() => null)) as { results?: Array<{ clientOpId: string; ok: boolean; error?: string }> } | null;
  if (!body?.results) return { synced: 0, failed: ops.length };

  let synced = 0;
  let failed = 0;
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  for (const r of body.results) {
    const op = ops.find((o) => o.clientOpId === r.clientOpId);
    if (!op) continue;
    op.state = r.ok ? "DONE" : "ERROR";
    op.lastError = r.ok ? null : (r.error ?? "Sync failed");
    if (r.ok) synced += 1;
    else failed += 1;
    store.put(op);
  }
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
  });
  return { synced, failed };
}

/** Register the service worker (idempotent). */
export function registerServiceWorker(): void {
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }
}
