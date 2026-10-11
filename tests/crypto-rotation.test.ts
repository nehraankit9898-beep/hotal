/**
 * Encryption-key rotation for STORED SECRETS — regression tests for the
 * keyring audit fix:
 *
 *  - Integration credentials (src/lib/crypto.ts) encrypted with an OLD
 *    INTEGRATION_ENCRYPTION_KEY must remain decryptable after rotation when
 *    the old key is declared in INTEGRATION_ENCRYPTION_PREVIOUS_KEYS.
 *    (Previously only BACKUP ARCHIVES fell back through previous keys —
 *    stored credentials and billing provider secrets became undecryptable
 *    after a rotation.)
 *  - Platform billing secrets (src/lib/saas/billing.ts) get the same
 *    rotation fallback.
 *  - Security properties are preserved: tampering fails against every
 *    candidate, and the tenant-binding AAD still rejects cross-tenant
 *    ciphertext transplants even with multiple keys configured.
 */
import "./queue-test-env";
import { describe, test, expect, afterAll } from "bun:test";

import {
  encryptCredentials,
  decryptCredentials,
  isEncryptedEnvelope,
  DecryptError,
} from "../src/lib/crypto";
import { encryptPlatformSecret, decryptPlatformSecret } from "../src/lib/saas/billing";
import {
  __resetEncryptionKeyCacheForTests,
  getIntegrationEncryptionKeyring,
} from "../src/lib/config";

// queue-test-env sets NODE_ENV=test/STAYLOOP_TEST=1 so the test-only cache
// reset hook is allowed.

const KEY_OLD = "aa".repeat(32);
const KEY_NEW = "bb".repeat(32);
const KEY_THIRD = "cc".repeat(32);

// PHASE 11 FIX (test-fixture env restoration): savedEnv was declared but NEVER
// POPULATED — afterAll iterated an empty object, so the last key set by the
// last useKey() call leaked for the rest of the process. The original values
// are now captured BEFORE the first mutation, and restoration DELETES unset
// variables instead of assigning undefined (which coerces to the literal
// string "undefined" and breaks every later consumer of the key).
const savedEnv: Record<string, string | undefined> = {
  INTEGRATION_ENCRYPTION_KEY: process.env.INTEGRATION_ENCRYPTION_KEY,
  INTEGRATION_ENCRYPTION_PREVIOUS_KEYS: process.env.INTEGRATION_ENCRYPTION_PREVIOUS_KEYS,
};

function useKey(hex: string, previous?: string): void {
  process.env.INTEGRATION_ENCRYPTION_KEY = hex;
  if (previous === undefined) delete process.env.INTEGRATION_ENCRYPTION_PREVIOUS_KEYS;
  else process.env.INTEGRATION_ENCRYPTION_PREVIOUS_KEYS = previous;
  __resetEncryptionKeyCacheForTests();
}

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else (process.env as Record<string, string>)[k] = v;
  }
  __resetEncryptionKeyCacheForTests();
});

describe("keyring — integration credentials survive key rotation", () => {
  test("credentials encrypted with the OLD key decrypt after rotation (previous key declared)", () => {
    useKey(KEY_OLD);
    const envelope = encryptCredentials(
      { hotelId: "hotel-1", integrationType: "WHATSAPP" },
      { token: "super-secret-token", phoneId: "123" },
    );
    expect(isEncryptedEnvelope(envelope)).toBe(true);

    // Rotate: new current key, old key declared as previous.
    useKey(KEY_NEW, `old2026:${KEY_OLD}`);
    const decrypted = decryptCredentials(
      { hotelId: "hotel-1", integrationType: "WHATSAPP" },
      envelope,
    );
    expect(decrypted).toEqual({ token: "super-secret-token", phoneId: "123" });
  });

  test("without the previous key declared, old ciphertexts fail closed", () => {
    useKey(KEY_OLD);
    const envelope = encryptCredentials(
      { hotelId: "hotel-1", integrationType: "SMS" },
      { sid: "AC123" },
    );

    useKey(KEY_NEW); // rotated, old key NOT declared
    expect(() =>
      decryptCredentials({ hotelId: "hotel-1", integrationType: "SMS" }, envelope),
    ).toThrow(DecryptError);
  });

  test("the current key is tried FIRST (fresh ciphertexts need no fallback)", () => {
    useKey(KEY_NEW, `old2026:${KEY_OLD}`);
    const envelope = encryptCredentials(
      { hotelId: "hotel-2", integrationType: "EMAIL" },
      { apiKey: "k" },
    );
    const decrypted = decryptCredentials(
      { hotelId: "hotel-2", integrationType: "EMAIL" },
      envelope,
    );
    expect(decrypted).toEqual({ apiKey: "k" });
  });

  test("multiple previous keys are honored in order", () => {
    useKey(KEY_OLD);
    const envelope = encryptCredentials({ hotelId: "h", integrationType: "T" }, { a: 1 });

    useKey(KEY_THIRD, `k1:${KEY_OLD},k2:${KEY_NEW}`);
    expect(decryptCredentials({ hotelId: "h", integrationType: "T" }, envelope)).toEqual({ a: 1 });
  });

  test("keyring contents reflect the declared previous keys", () => {
    useKey(KEY_NEW, `old2026:${KEY_OLD}`);
    const ring = getIntegrationEncryptionKeyring();
    expect(ring.map((k) => k.id)).toEqual(["default", "old2026"]);
    expect(ring[0].key.toString("hex")).toBe(KEY_NEW);
    expect(ring[1].key.toString("hex")).toBe(KEY_OLD);
  });

  test("malformed previous-key entries are skipped, not fatal", () => {
    useKey(KEY_NEW, "not-a-valid-entry,alsobad:,old2026:" + KEY_OLD);
    const ring = getIntegrationEncryptionKeyring();
    expect(ring.map((k) => k.id)).toEqual(["default", "old2026"]);
  });
});

describe("keyring — security properties are preserved under rotation", () => {
  test("a TAMPERED envelope fails against every candidate key", () => {
    useKey(KEY_OLD);
    const envelope = encryptCredentials(
      { hotelId: "hotel-1", integrationType: "WHATSAPP" },
      { token: "t" },
    );
    const parts = envelope.split(":");
    // Flip a ciphertext byte.
    const ct = Buffer.from(parts[2], "base64");
    ct[0] ^= 0xff;
    parts[2] = ct.toString("base64");
    const tampered = parts.join(":");

    useKey(KEY_NEW, `old2026:${KEY_OLD}`);
    expect(() =>
      decryptCredentials({ hotelId: "hotel-1", integrationType: "WHATSAPP" }, tampered),
    ).toThrow(DecryptError);
  });

  test("cross-tenant ciphertext transplant is rejected even with many keys configured", () => {
    useKey(KEY_NEW, `old2026:${KEY_OLD}`);
    const envelope = encryptCredentials(
      { hotelId: "hotel-A", integrationType: "WHATSAPP" },
      { token: "t" },
    );
    // Same keyring, WRONG tenant context → AAD mismatch on every candidate.
    expect(() =>
      decryptCredentials({ hotelId: "hotel-B", integrationType: "WHATSAPP" }, envelope),
    ).toThrow(DecryptError);
    // Same tenant, WRONG integration type → also rejected.
    expect(() =>
      decryptCredentials({ hotelId: "hotel-A", integrationType: "SMS" }, envelope),
    ).toThrow(DecryptError);
  });
});

describe("keyring — platform billing secrets survive key rotation", () => {
  test("Razorpay-style webhook secret decrypts after rotation via previous key", () => {
    useKey(KEY_OLD);
    const envelope = encryptPlatformSecret(
      "whsec_live_secret_value_0123456789",
      "razorpay-webhook",
    );

    useKey(KEY_NEW, `old2026:${KEY_OLD}`);
    expect(decryptPlatformSecret(envelope, "razorpay-webhook")).toBe(
      "whsec_live_secret_value_0123456789",
    );
  });

  test("platform secret context is bound (AAD) — wrong context fails", () => {
    useKey(KEY_NEW, `old2026:${KEY_OLD}`);
    const envelope = encryptPlatformSecret("sk_live_stripe_key", "stripe-api");
    expect(() => decryptPlatformSecret(envelope, "razorpay-webhook")).toThrow();
  });

  test("rotation without declaring the old key fails with a clear error", () => {
    useKey(KEY_OLD);
    const envelope = encryptPlatformSecret("value", "stripe-api");
    useKey(KEY_NEW);
    expect(() => decryptPlatformSecret(envelope, "stripe-api")).toThrow(
      /could not be decrypted|Bad secret/,
    );
  });
});
