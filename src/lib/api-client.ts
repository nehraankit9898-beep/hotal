/** Typed fetch wrapper — friendly error messages, never raw backend errors.
 *  Session works in two modes:
 *  1. Cookie (primary, httpOnly) — normal top-level browsing.
 *  2. Bearer token (fallback) — stored here, used when the browser blocks
 *     cookies in embedded cross-site iframe contexts (preview panel). */

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const TOKEN_KEY = "stayloop_session_token";

export function storeSessionToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage unavailable — cookie mode will be used
  }
}

export function clearSessionToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** CSRF double-submit token (Phase 8): cookie value echoed via header. */
function getCsrfToken(): string | null {
  try {
    const match = document.cookie
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("stayloop_csrf="));
    return match ? decodeURIComponent(match.slice("stayloop_csrf=".length)) : null;
  } catch {
    return null;
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const token = getStoredToken();
  const csrf = getCsrfToken();
  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        // Phase 8: echo the CSRF cookie on state-changing requests.
        ...(csrf && options?.method && !["GET", "HEAD", "OPTIONS"].includes(options.method)
          ? { "x-csrf-token": csrf }
          : {}),
        ...(options?.headers || {}),
      },
    });
  } catch {
    throw new ApiError(
      "Cannot reach the server. Please check your connection and try again.",
      "NETWORK",
      0,
    );
  }

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON response
  }

  if (!res.ok) {
    const message =
      (data as { error?: { message?: string } })?.error?.message ||
      "Something went wrong. Please try again.";
    const code = (data as { error?: { code?: string } })?.error?.code || "ERROR";
    throw new ApiError(message, code, res.status);
  }

  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body?: unknown) =>
    request<T>(url, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(url: string, body?: unknown) =>
    request<T>(url, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(url: string, body?: unknown) =>
    request<T>(url, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(url: string) => request<T>(url, { method: "DELETE" }),
};
