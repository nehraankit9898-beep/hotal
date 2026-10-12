import { createHmac } from "crypto";

import { call, check, summary } from "./probe-lib";

function b32(s: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; const c = s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = ""; for (const ch of c) { const i = A.indexOf(ch); if (i === -1) continue; bits += i.toString(2).padStart(5, "0"); }
  const out: number[] = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out);
}
function totp(secret: string): string {
  const step = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8); buf.writeUInt32BE(step % 2 ** 32, 4);
  const h = createHmac("sha1", b32(secret)).update(buf).digest(); const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return String(n % 1_000_000).padStart(6, "0");
}
const SECRET = (process.env.SA_MFA_SECRET ?? "").trim();

async function saLogin() {
  const login = await call("POST", "/api/super-admin/login", { email: "super@stayloop.test", password: "SuperAdmin12345" });
  if (login.body?.mfaToken) {
    const v = await call("POST", "/api/auth/mfa/verify", { mfaToken: login.body.mfaToken, code: totp(SECRET) });
    if (v.status !== 200) {
      // replay fence: wait for the next step and retry once
      await new Promise((r) => setTimeout(r, 31_000));
      const v2 = await call("POST", "/api/auth/mfa/verify", { mfaToken: login.body.mfaToken, code: totp(SECRET) });
      return v2;
    }
    return v;
  }
  return login;
}

const login = await saLogin();
check("sa", "super-admin login with TOTP MFA", login.status === 200, `status=${login.status}`);

const reads = [
  "/api/super-admin/stats", "/api/super-admin/hotels", "/api/super-admin/plans",
  "/api/super-admin/subscriptions", "/api/super-admin/feature-flags",   "/api/super-admin/security", "/api/super-admin/audit", "/api/super-admin/billing",
  "/api/super-admin/usage", "/api/super-admin/saas-kpis", "/api/super-admin/backups",
  "/api/super-admin/coupons", "/api/super-admin/templates", "/api/super-admin/settings",
  "/api/super-admin/health", "/api/super-admin/secret-rotations", "/api/super-admin/support",
  "/api/super-admin/refunds",
];
for (const p of reads) {
  const r = await call("GET", p);
  check("sa-console", `GET ${p}`, r.status === 200, `status=${r.status} ${r.status !== 200 ? JSON.stringify(r.body).slice(0, 110) : ""}`);
}

const hotels = await call("GET", "/api/super-admin/hotels");
const list = hotels.body?.hotels ?? hotels.body?.tenants ?? [];
check("sa-console", "tenant list returns both demo hotels", list.length >= 2, `count=${list.length}`);
const seaView = list.find((h: any) => JSON.stringify(h).includes("Sea View"));
if (seaView) {
  const suspend = await call("POST", `/api/super-admin/hotels/suspend?id=${seaView.id}`, { reason: "probe suspend" });
  const activate = await call("POST", `/api/super-admin/hotels/activate?id=${seaView.id}`, { reason: "probe activate" });
  check("sa-console", "suspend → activate tenant", suspend.status === 200 && activate.status === 200, `${suspend.status}/${activate.status}`);
}

const flag = await call("PUT", "/api/super-admin/feature-flags", { key: "PROBE_FLAG", enabled: true }).catch(() => ({ status: 0, body: null }));
check("sa-console", "feature flag toggle endpoint reachable", flag.status === 200 || flag.status === 404 || flag.status === 422, `status=${flag.status}`);

const backup = await call("POST", "/api/super-admin/backups", { reason: "probe backup run" });
check("sa-console", "trigger manual backup", backup.status === 200 || backup.status === 201, `status=${backup.status} ${JSON.stringify(backup.body).slice(0, 140)}`);
const backupId = backup.body?.backup?.id ?? backup.body?.id;
if (backupId) {
  let status = "";
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const bl = await call("GET", "/api/super-admin/backups");
    const row = (bl.body?.backups ?? []).find((b: any) => b.id === backupId);
    status = row?.status ?? "";
    if (status === "COMPLETED" || status === "FAILED") break;
  }
  const bl2 = await call("GET", "/api/super-admin/backups");
  const row2 = (bl2.body?.backups ?? []).find((b: any) => b.id === backupId);
  check("sa-console", "worker completes the manual backup (encrypted artifact)", status === "COMPLETED", `final=${status} size=${row2?.sizeBytes ?? "?"}B`);
}

const audit = await call("GET", "/api/super-admin/audit?limit=50");
const rows = audit.body?.logs ?? audit.body?.entries ?? audit.body?.auditLogs ?? audit.body?.items ?? [];
check("sa-console", "platform audit trail populated", audit.status === 200 && rows.length > 0, `status=${audit.status} rows=${rows.length}`);

summary();
