/**
 * Shared helpers for the security test suite.
 */
import { createHmac } from "crypto";

export const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3100";
export const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? "TestAdmin123";
export const STAFF_PASSWORD = process.env.TEST_STAFF_PASSWORD ?? "TestStaff123";
export const WEBHOOK_SECRET = process.env.TRACKING_WEBHOOK_SECRET ?? "";

export interface Jar {
  cookie: string;
  csrf: string;
}

/** Extract session + csrf cookies from a login response. */
export function jarFromResponse(res: Response): Jar {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  let session = "";
  let csrf = "";
  for (const sc of setCookies) {
    const pair = sc.split(";")[0];
    if (pair.startsWith("stayloop_session=")) session = pair;
    if (pair.startsWith("stayloop_csrf=")) csrf = pair;
  }
  const csrfValue = csrf ? decodeURIComponent(csrf.split("=").slice(1).join("=")) : "";
  return { cookie: [session, csrf].filter(Boolean).join("; "), csrf: csrfValue };
}

export async function login(
  email: string,
  password: string,
): Promise<{ jar: Jar; body: any; res: Response }> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => null);
  return { jar: jarFromResponse(res), body, res };
}

export async function apiCall(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  opts?: { jar?: Jar; bearer?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts?.headers,
  };
  if (opts?.jar) headers.cookie = opts.jar.cookie;
  if (opts?.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts?.jar?.csrf && method !== "GET") headers["x-csrf-token"] = opts.jar.csrf;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** Sign a webhook payload the way a real provider would. */
export function signWebhook(
  secret: string,
  rawBody: string,
  timestamp?: string,
): Record<string, string> {
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  return {
    "x-webhook-signature": createHmac("sha256", secret)
      .update(`${ts}.${rawBody}`)
      .digest("base64url"),
    "x-webhook-timestamp": ts,
    "Content-Type": "application/json",
  };
}

export async function rawWebhook(path: string, rawBody: string, headers: Record<string, string>) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: rawBody,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export const HOTEL_A_ADMIN = "admin@grandpalace.com";
export const HOTEL_B_ADMIN = "admin@seaview.com";
export const HOTEL_A_STAFF = "staff@grandpalace.com";
