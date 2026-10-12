/**
 * Shared HTTP helpers for the StayLoop feature probes.
 */
const BASE = process.env.PROBE_BASE ?? "http://localhost:3000";

export const state = { cookieJar: "", csrf: "" };

export const results: { area: string; what: string; ok: boolean; detail: string }[] = [];

function storeCookies(res: Response) {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const sc of setCookies) {
    const pair = sc.split(";")[0];
    const [name] = pair.split("=");
    const others = state.cookieJar
      .split("; ")
      .filter(Boolean)
      .filter((c) => !c.startsWith(`${name}=`));
    state.cookieJar = [...others, pair].join("; ");
    if (name === "stayloop_csrf") state.csrf = decodeURIComponent(pair.split("=").slice(1).join("="));
  }
}

export async function call(
  method: string,
  path: string,
  body?: unknown,
  opts: { bearer?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (state.cookieJar) headers.cookie = state.cookieJar;
  if (state.csrf && method !== "GET") headers["x-csrf-token"] = state.csrf;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  storeCookies(res);
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.slice(0, 200);
  }
  return { status: res.status, body: parsed };
}
call.jar = "";

export function check(area: string, what: string, ok: boolean, detail = "") {
  results.push({ area, what, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  [${area}] ${what}${detail ? ` — ${detail}` : ""}`);
}

export function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed; ${failed.length} failed ====`);
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  [${f.area}] ${f.what} — ${f.detail}`);
  }
  return failed.length;
}
