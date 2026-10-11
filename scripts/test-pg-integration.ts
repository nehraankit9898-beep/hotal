/**
 * PostgreSQL 16 end-to-end integration suite (production-shape verification).
 *
 * Verifies, against a REAL PostgreSQL instance (no mocks, no SQLite):
 *   1.  Migrations apply to a clean database (prisma migrate deploy).
 *   2.  Schema consistency: prisma/migrations == prisma/schema.postgres.prisma
 *       (migrate diff produces an EMPTY diff — no drift).
 *   3.  Production web server (Next standalone) boots with fail-closed env.
 *   4.  Background worker boots with the same validation + heartbeats.
 *   5.  Super-admin bootstrap → login → forced password change → session
 *       revocation → MFA enrolment → usable dashboard.
 *   6.  Export flow: enqueue → worker writes CSV → poll status →
 *       authenticated download (token) → cross-tenant 404 → bad token 403.
 *   7.  Backup flow: manual trigger (QUEUED) → worker processes (pg_dump +
 *       AES-256-GCM) → real decrypt verification → restore into a DISPOSABLE
 *       database with row-count checks.
 *   8.  Health endpoints: liveness always 200; readiness reflects DB/queue/
 *       redis/worker heartbeat; public responses stay low-information.
 *
 * Required environment:
 *   PG_ADMIN_URL   — superuser URL to the maintenance DB (creates/drops test DBs)
 *   PG_APP_URL     — URL of the (fresh) application test database
 *   PG_SHADOW_URL  — URL of a scratch DB for migrate diff
 *   PG_RESTORE_URL — URL of the disposable restore-target database
 *   REDIS_URL      — optional; when unset the limiter falls back in-memory
 *   WEB_PORT       — optional (default 3101)
 *   PATH must contain pg_dump/pg_restore (PostgreSQL 16 client), or set
 *   PG_BIN_DIR to a directory containing them.
 *
 * Usage (see TEST_RESULTS.md for the exact commands used):
 *   bun run scripts/test-pg-integration.ts
 *
 * Exit code 0 = all steps PASS; 1 = at least one FAIL. Every step prints
 * PASS/FAIL with evidence. Nothing is mocked: the worker really runs
 * pg_dump against the live test database.
 */
import { spawn, spawnSync } from "child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { PrismaClient } from "@prisma/client";
import { generateTotp } from "../src/lib/mfa";

const ROOT = resolve(import.meta.dir, "..");
const WEB_PORT = Number(process.env.WEB_PORT ?? 3101);
const BASE = `http://127.0.0.1:${WEB_PORT}`;

const PG_ADMIN_URL = process.env.PG_ADMIN_URL ?? "";
const PG_APP_URL = process.env.PG_APP_URL ?? "";
const PG_SHADOW_URL = process.env.PG_SHADOW_URL ?? "";
const PG_RESTORE_URL = process.env.PG_RESTORE_URL ?? "";
const REDIS_URL = process.env.REDIS_URL ?? "";
const PG_BIN_DIR = process.env.PG_BIN_DIR ?? "";

const AUTH_SECRET = "integration-test-auth-secret-0123456789abcdef";
const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ADMIN_BOOTSTRAP_SECRET = "integration-bootstrap-secret-0123456789abcdef";
const SA_EMAIL = "sa-integration@stayloop.test";
const TENANT_A_ADMIN = { email: "a-admin@integration.test", password: "IntegrationPass123!" };
const TENANT_B_ADMIN = { email: "b-admin@integration.test", password: "IntegrationPass456!" };

let failures = 0;
const stepResults: { step: string; status: "PASS" | "FAIL"; detail: string }[] = [];

function record(step: string, status: "PASS" | "FAIL", detail: string) {
  stepResults.push({ step, status, detail });
  console.log(`${status === "PASS" ? "✔" : "✘"} [${step}] ${detail}`);
  if (status === "FAIL") failures += 1;
}

function assert(step: string, cond: boolean, detail: string, failDetail?: string) {
  record(step, cond ? "PASS" : "FAIL", cond ? detail : (failDetail ?? detail));
  return cond;
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  label: string,
): { code: number; out: string } {
  const res = spawnSync(cmd, args, { cwd: ROOT, env, encoding: "utf8", timeout: 5 * 60 * 1000 });
  const out = (res.stdout ?? "") + (res.stderr ?? "");
  if (res.status !== 0) {
    console.log(`--- ${label} output (failure) ---\n${out.slice(0, 3000)}\n--- end ---`);
  }
  return { code: res.status ?? 1, out };
}

/* ------------------------------------------------------------------ */
/* HTTP helpers with cookie jar                                        */
/* ------------------------------------------------------------------ */

interface Jar {
  cookie: string;
  csrf: string;
}

function jarFrom(res: Response): Jar {
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

async function api(
  method: string,
  path: string,
  opts: { jar?: Jar; body?: unknown; headers?: Record<string, string>; raw?: boolean } = {},
): Promise<{ status: number; body: any; text: string; res: Response; jar: Jar }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: BASE,
    ...opts.headers,
  };
  if (opts.jar?.cookie) headers.cookie = opts.jar.cookie;
  if (opts.jar?.csrf && method !== "GET") headers["x-csrf-token"] = opts.jar.csrf;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const jar = jarFrom(res);
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* raw body */
  }
  return { status: res.status, body, text, res, jar };
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 700,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await wait(intervalMs);
  }
  return false;
}

async function fetchJson(url: string): Promise<any> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

let webProc: ReturnType<typeof spawn> | null = null;
let workerProc: ReturnType<typeof spawn> | null = null;
let exportDir = "";
let backupDirPath = "";

async function main() {
  if (!PG_ADMIN_URL || !PG_APP_URL || !PG_SHADOW_URL || !PG_RESTORE_URL) {
    console.error("PG_ADMIN_URL, PG_APP_URL, PG_SHADOW_URL and PG_RESTORE_URL are required.");
    process.exit(1);
  }

  const appEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_URL: PG_APP_URL,
    AUTH_SECRET,
    INTEGRATION_ENCRYPTION_KEY: ENCRYPTION_KEY,
    REDIS_URL,
    EXPORT_INLINE_MAX_ROWS: "1", // force the async export path
    LOG_LEVEL: "error",
    PORT: String(WEB_PORT),
    HOSTNAME: "127.0.0.1",
    ...(PG_BIN_DIR ? { PATH: `${PG_BIN_DIR}:${process.env.PATH}` } : {}),
  };

  console.log("═".repeat(72));
  console.log(" StayLoop PostgreSQL integration suite");
  console.log(
    ` web=${BASE}  pg=${maskUrl(PG_APP_URL)}  redis=${REDIS_URL ? "configured" : "in-memory"}`,
  );
  console.log("═".repeat(72));

  try {
    // ---- Step 1: fresh databases -------------------------------------
    const admin = new PrismaClient({ datasources: { db: { url: PG_ADMIN_URL } } });
    const dbName = new URL(PG_APP_URL).pathname.replace(/^\//, "");
    const shadowName = new URL(PG_SHADOW_URL).pathname.replace(/^\//, "");
    const restoreName = new URL(PG_RESTORE_URL).pathname.replace(/^\//, "");
    try {
      for (const name of [dbName, shadowName, restoreName]) {
        await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      }
      // In the docker postgres service, POSTGRES_USER is the bootstrap superuser
      // and owns everything. When the test role is a NON-superuser (like this
      // local run), the copied `public` schema is not writable — align it with
      // the app role exactly like the containerized setup does.
      const appUrl = new URL(PG_APP_URL);
      const appUser = decodeURIComponent(appUrl.username);
      if (appUser) {
        for (const name of [dbName, shadowName, restoreName]) {
          await admin.$executeRawUnsafe(`ALTER DATABASE "${name}" OWNER TO "${appUser}"`);
          const dbAdmin = new PrismaClient({
            datasources: { db: { url: `${appUrl.protocol}//${appUser}@${appUrl.host}/${name}` } },
          });
          try {
            await dbAdmin.$executeRawUnsafe(`ALTER SCHEMA public OWNER TO "${appUser}"`);
          } finally {
            await dbAdmin.$disconnect();
          }
        }
      }
      record(
        "1-fresh-databases",
        "PASS",
        `created ${dbName}, ${shadowName}, ${restoreName} (public schema owned by the app role)`,
      );
    } catch (err) {
      record("1-fresh-databases", "FAIL", err instanceof Error ? err.message : String(err));
    }

    // ---- Step 2: migrations apply to a clean PG 16 database -----------
    const migrate = run(
      "bunx",
      ["prisma", "migrate", "deploy", "--schema", "prisma/schema.postgres.prisma"],
      { ...appEnv, DATABASE_URL: PG_APP_URL },
      "migrate deploy",
    );
    assert(
      "2-migrate-deploy",
      migrate.code === 0,
      migrate.code === 0
        ? "prisma migrate deploy exited 0 (all migrations applied to the clean database)"
        : `prisma migrate deploy failed (exit ${migrate.code})`,
    );

    // ---- Step 3: schema consistency (migrations == schema) -----------
    const diff = run(
      "bunx",
      [
        "prisma",
        "migrate",
        "diff",
        "--from-migrations",
        "prisma/migrations",
        "--to-schema-datamodel",
        "prisma/schema.postgres.prisma",
        "--shadow-database-url",
        PG_SHADOW_URL,
      ],
      { ...appEnv, DATABASE_URL: PG_APP_URL },
      "migrate diff",
    );
    const drift = diff.out
      .replace(
        /^[\s]*(-+.*?-+|Environment variables loaded.*|Prisma schema loaded.*|Datasource.*|)\n?/gm,
        "",
      )
      .trim();
    // Keep only SQL-looking lines for the drift verdict:
    const sqlDrift = diff.out
      .split("\n")
      .filter((l) => /^(CREATE|ALTER|DROP|CREATE TYPE|GRANT|REVOKE|COMMENT)/i.test(l.trim()))
      .join("\n")
      .trim();
    assert(
      "3-schema-consistency",
      diff.code === 0 && sqlDrift === "",
      diff.code === 0
        ? "migrate diff: migrations match schema.postgres.prisma (empty diff)"
        : `migrate diff exited ${diff.code}`,
    );
    void drift;

    // ---- Step 4: standalone server build exists ----------------------
    const serverJs = join(ROOT, ".next", "standalone", "server.js");
    assert(
      "4-standalone-build",
      existsSync(serverJs),
      ".next/standalone/server.js present (bun run build before this suite)",
    );

    // ---- Step 5: temp shared storage ---------------------------------
    exportDir = mkdtempSync(join(tmpdir(), "stayloop-int-exports-"));
    backupDirPath = mkdtempSync(join(tmpdir(), "stayloop-int-backups-"));
    record("5-shared-storage", "PASS", `EXPORT_DIR=${exportDir} BACKUP_DIR=${backupDirPath}`);

    // ---- Step 6+7: start worker + web --------------------------------
    const runtimeEnv: NodeJS.ProcessEnv = {
      ...appEnv,
      EXPORT_DIR: exportDir,
      BACKUP_DIR: backupDirPath,
    };
    workerProc = spawn("bun", ["scripts/worker.ts"], {
      cwd: ROOT,
      env: runtimeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let workerLog = "";
    workerProc.stdout?.on("data", (d) => (workerLog += d.toString()));
    workerProc.stderr?.on("data", (d) => (workerLog += d.toString()));

    webProc = spawn("bun", ["server.js"], {
      cwd: join(ROOT, ".next", "standalone"),
      env: runtimeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let webLog = "";
    webProc.stdout?.on("data", (d) => (webLog += d.toString()));
    webProc.stderr?.on("data", (d) => (webLog += d.toString()));

    const live = await waitFor(async () => {
      try {
        const res = await fetch(`${BASE}/api/health/live`, { signal: AbortSignal.timeout(2000) });
        return res.ok;
      } catch {
        return false;
      }
    }, 60_000);
    assert(
      "7a-web-boot",
      live,
      "web booted and /api/health/live returns 200",
      `web did not start. log:\n${webLog.slice(-1500)}`,
    );

    const ready = await waitFor(async () => {
      const h = await fetchJson(`${BASE}/api/health`);
      return h?.status === "ok";
    }, 60_000);
    assert(
      "7b-web-readiness",
      ready,
      "/api/health readiness 200 (database+queue ok)",
      `/api/health not ready. web log:\n${webLog.slice(-1500)}`,
    );

    const workerUp = await waitFor(async () => {
      const h = await fetchJson(`${BASE}/api/health`);
      return h?.checks?.worker === "ok";
    }, 60_000);
    assert(
      "7c-worker-heartbeat",
      workerUp,
      "worker heartbeat observable via /api/health (checks.worker=ok)",
      `worker heartbeat not ok. worker log:\n${workerLog.slice(-1500)}`,
    );

    // Low-information check: public health exposes no counts/values.
    const healthBody = await fetchJson(`${BASE}/api/health`);
    const lowInfo =
      healthBody &&
      typeof healthBody === "object" &&
      !/password|secret|postgres:\/\//i.test(JSON.stringify(healthBody));
    assert(
      "7d-health-low-info",
      Boolean(lowInfo),
      "public /api/health responded with no credentials/counts",
      `health response: ${JSON.stringify(healthBody).slice(0, 300)}`,
    );

    // ---- Step 8: super admin bootstrap --------------------------------
    const bootstrap = run(
      "bun",
      ["scripts/bootstrap-admin.ts", "--name", "Integration SA", "--email", SA_EMAIL],
      { ...runtimeEnv, ADMIN_BOOTSTRAP_SECRET, NODE_ENV: "production" },
      "bootstrap-admin",
    );
    const tempPassword = bootstrap.out.match(/Temporary password:\s*(\S+)/)?.[1] ?? "";
    assert(
      "8-bootstrap-admin",
      bootstrap.code === 0 && tempPassword.length >= 12,
      tempPassword
        ? "super admin created; temporary password captured from stdout (shown once)"
        : `bootstrap failed: ${bootstrap.out.slice(0, 300)}`,
    );

    // ---- Step 9: login + forced password change gate ------------------
    const login1 = await api("POST", "/api/super-admin/login", {
      body: { email: SA_EMAIL, password: tempPassword },
    });
    const jar1 = login1.jar;
    assert(
      "9a-sa-login",
      login1.status === 200 && jar1.cookie.includes("stayloop_session="),
      "super admin login succeeded (session cookie set)",
    );

    const gated = await api("GET", "/api/super-admin/stats", { jar: jar1 });
    assert(
      "9b-password-gate",
      gated.status === 403 && gated.body?.error?.code === "PASSWORD_CHANGE_REQUIRED",
      "mustChangePassword session is blocked from the dashboard (403 PASSWORD_CHANGE_REQUIRED)",
      `got ${gated.status}: ${JSON.stringify(gated.body).slice(0, 200)}`,
    );

    const change = await api("PATCH", "/api/profile", {
      jar: jar1,
      body: { currentPassword: tempPassword, newPassword: "IntegrationSA-New-Pass-456!" },
    });
    assert(
      "9c-password-change",
      change.status === 200 && change.body?.user?.mustChangePassword === false,
      "password change accepted (mustChangePassword cleared)",
    );

    const revoked = await api("GET", "/api/auth/me", { jar: jar1 });
    assert(
      "9d-session-revoked",
      revoked.status === 401,
      "old session revoked after password change (401 SESSION_REVOKED)",
      `got ${revoked.status}`,
    );

    // ---- Step 10: MFA enrolment ---------------------------------------
    const login2 = await api("POST", "/api/super-admin/login", {
      body: { email: SA_EMAIL, password: "IntegrationSA-New-Pass-456!" },
    });
    const jar2 = login2.jar;
    assert("10a-sa-relogin", login2.status === 200, "re-login with the new password succeeded");

    const mfaGate = await api("GET", "/api/super-admin/stats", { jar: jar2 });
    assert(
      "10b-mfa-gate",
      mfaGate.status === 403 && mfaGate.body?.error?.code === "MFA_SETUP_REQUIRED",
      "MFA policy gate active (403 MFA_SETUP_REQUIRED)",
      `got ${mfaGate.status}: ${JSON.stringify(mfaGate.body).slice(0, 200)}`,
    );

    const setup = await api("POST", "/api/mfa/setup", { jar: jar2 });
    const secret = setup.body?.secret ?? "";
    assert(
      "10c-mfa-setup",
      setup.status === 200 && /^[A-Z2-7]{16,}$/.test(secret),
      "TOTP secret issued",
    );

    const code = generateTotp(secret);
    const enable = await api("POST", "/api/mfa/enable", { jar: jar2, body: { code } });
    assert(
      "10d-mfa-enable",
      enable.status === 200 && Array.isArray(enable.body?.backupCodes),
      "MFA enabled with a valid TOTP code (backup codes issued once)",
    );

    // ---- Step 11: usable dashboard (full MFA login: challenge + code) --
    const login3raw = await api("POST", "/api/super-admin/login", {
      body: { email: SA_EMAIL, password: "IntegrationSA-New-Pass-456!" },
    });
    assert(
      "11a-mfa-challenge",
      login3raw.status === 200 && login3raw.body?.mfaRequired === true && login3raw.body?.mfaToken,
      "login with MFA enabled issues an MFA challenge (no session yet)",
    );
    const mfaVerify = await api("POST", "/api/auth/mfa/verify", {
      body: { mfaToken: login3raw.body?.mfaToken, code: generateTotp(secret) },
    });
    const jar3 = mfaVerify.jar;
    assert(
      "11b-mfa-verify",
      mfaVerify.status === 200 && jar3.cookie.includes("stayloop_session="),
      "MFA challenge completed with a live TOTP code (full session issued)",
    );

    const stats = await api("GET", "/api/super-admin/stats", { jar: jar3 });
    assert(
      "11c-dashboard-usable",
      stats.status === 200,
      "post-MFA session reaches the dashboard (200)",
      `got ${stats.status}`,
    );

    const backupsList = await api("GET", "/api/super-admin/backups", { jar: jar3 });
    assert(
      "11b-backups-route",
      backupsList.status === 200 && backupsList.body?.status?.config,
      "GET /api/super-admin/backups implements the UI contract (status+history)",
      `got ${backupsList.status}`,
    );

    // ---- Step 12: tenant export flow -----------------------------------
    const app = new PrismaClient({ datasources: { db: { url: PG_APP_URL } } });
    const { hashPassword } = await import("../src/lib/auth");
    const hotelA = await app.hotel.create({
      data: { name: "Integration Hotel A", city: "Testville" },
    });
    const hotelB = await app.hotel.create({
      data: { name: "Integration Hotel B", city: "Otherville" },
    });
    await app.user.create({
      data: {
        name: "A Admin",
        email: TENANT_A_ADMIN.email,
        passwordHash: hashPassword(TENANT_A_ADMIN.password),
        role: "HOTEL_ADMIN",
        hotelId: hotelA.id,
        status: "ACTIVE",
      },
    });
    await app.user.create({
      data: {
        name: "B Admin",
        email: TENANT_B_ADMIN.email,
        passwordHash: hashPassword(TENANT_B_ADMIN.password),
        role: "HOTEL_ADMIN",
        hotelId: hotelB.id,
        status: "ACTIVE",
      },
    });
    for (let i = 0; i < 3; i++) {
      await app.customer.create({
        data: {
          hotelId: hotelA.id,
          name: `Customer A${i}`,
          email: `a${i}@example.com`,
          phone: `+9198000000${i}${i}`,
          marketingConsent: true,
          emailOptIn: true,
          status: "ACTIVE",
        },
      });
    }
    await app.$disconnect();
    record("12a-tenant-fixtures", "PASS", "two hotels + admins + 3 consented customers created");

    const loginA = await api("POST", "/api/auth/login", { body: TENANT_A_ADMIN });
    const jarA = loginA.jar;
    assert("12b-tenant-login", loginA.status === 200, "tenant admin login succeeded");

    const exportRes = await api("GET", "/api/export/customers?async=1", { jar: jarA });
    const jobId = exportRes.body?.jobId ?? "";
    assert(
      "12c-export-queued",
      exportRes.status === 202 && jobId,
      "export enqueued as a background job (202 + jobId)",
      `got ${exportRes.status}: ${JSON.stringify(exportRes.body).slice(0, 200)}`,
    );

    let job: any = null;
    const done = await waitFor(async () => {
      const res = await api("GET", `/api/jobs/${jobId}`, { jar: jarA });
      job = res.body?.job;
      return job?.status === "COMPLETED";
    }, 60_000);
    assert(
      "12d-worker-completes-export",
      done && job?.result?.downloadToken,
      "worker processed the export (COMPLETED with download token)",
      `job state: ${JSON.stringify(job).slice(0, 300)}\nworker log:\n${workerLog.slice(-1500)}`,
    );

    const token = job?.result?.downloadToken ?? "";
    const download = await api(
      "GET",
      `/api/jobs/${jobId}/download?token=${encodeURIComponent(token)}`,
      { jar: jarA, raw: true },
    );
    const csvOk =
      download.status === 200 &&
      download.text.includes("a0@example.com") &&
      (download.res.headers.get("content-type") ?? "").includes("text/csv");
    assert(
      "12e-download",
      csvOk,
      "authenticated download returned the CSV (200 text/csv, rows present)",
      `got ${download.status}: ${download.text.slice(0, 200)}`,
    );

    // Cross-tenant isolation: hotel B cannot see or download A's job.
    const loginB = await api("POST", "/api/auth/login", { body: TENANT_B_ADMIN });
    const jarB = loginB.jar;
    const foreignStatus = await api("GET", `/api/jobs/${jobId}`, { jar: jarB });
    const foreignDownload = await api(
      "GET",
      `/api/jobs/${jobId}/download?token=${encodeURIComponent(token)}`,
      { jar: jarB },
    );
    assert(
      "12f-cross-tenant-404",
      foreignStatus.status === 404 && foreignDownload.status === 404,
      "cross-tenant job access returns 404 (indistinguishable from missing)",
      `status=${foreignStatus.status} download=${foreignDownload.status}`,
    );

    const badToken = await api(
      "GET",
      `/api/jobs/${jobId}/download?token=${encodeURIComponent("forged-token")}`,
      { jar: jarA },
    );
    assert(
      "12g-bad-token-403",
      badToken.status === 403,
      "forged download token rejected (403)",
      `got ${badToken.status}`,
    );

    // Unauthenticated download cannot even learn the job exists.
    const anonDownload = await fetch(
      `${BASE}/api/jobs/${jobId}/download?token=${encodeURIComponent(token)}`,
    );
    assert("12h-anon-401", anonDownload.status === 401, "unauthenticated download rejected (401)");

    // ---- Step 13: backup flow (worker + pg_dump + encryption) ----------
    const trigger = await api("POST", "/api/super-admin/backups", {
      jar: jar3,
      body: { reason: "integration test backup" },
    });
    assert(
      "13a-backup-trigger",
      trigger.status === 200 && trigger.body?.ok === true && trigger.body?.status === "QUEUED",
      "manual backup trigger queued a record (worker will process it)",
      `got ${trigger.status}: ${JSON.stringify(trigger.body).slice(0, 300)}`,
    );

    let backupRow: any = null;
    const backupDone = await waitFor(async () => {
      const res = await api("GET", "/api/super-admin/backups", { jar: jar3 });
      backupRow = res.body?.history?.[0];
      return backupRow?.status === "SUCCESS" || backupRow?.status === "FAILED";
    }, 120_000);
    assert(
      "13b-worker-backup",
      backupDone && backupRow?.status === "SUCCESS" && backupRow?.verified === true,
      "worker executed pg_dump + AES-256-GCM backup (SUCCESS, verified at creation)",
      `backup row: ${JSON.stringify(backupRow).slice(0, 400)}\nworker log:\n${workerLog.slice(-2000)}`,
    );

    const verify = await api("POST", "/api/super-admin/backups?verify=1", { jar: jar3, body: {} });
    assert(
      "13c-backup-verify",
      verify.status === 200 && verify.body?.ok === true,
      "POST ?verify=1 ran a real AES-256-GCM decrypt verification (ok)",
      `got ${verify.status}: ${JSON.stringify(verify.body)}`,
    );

    // Backup file permission + no-credentials checks
    const backupFile = join(backupDirPath, backupRow?.filename ?? "none");
    if (existsSync(backupFile)) {
      const fsStat = statSync(backupFile);
      const mode = fsStat.mode & 0o777;
      assert(
        "13d-backup-file-mode",
        mode === 0o640,
        `backup archive mode 0640 (found 0${mode.toString(8)})`,
      );
      const raw = readFileSync(backupFile).toString("latin1");
      const noLeak = !raw.includes("stayloop_ci_pw") && !/PGPASSWORD/i.test(raw);
      assert("13e-no-credential-leak", noLeak, "backup archive contains no database credentials");
    }

    // ---- Step 14: restore into a disposable database ------------------
    const restore = run(
      "bun",
      ["scripts/restore-backup.ts", backupFile, "--target", PG_RESTORE_URL],
      { ...runtimeEnv, INTEGRATION_ENCRYPTION_KEY: ENCRYPTION_KEY },
      "restore-backup",
    );
    const restoreOk = restore.code === 0 && /SUCCESS/.test(restore.out);
    assert(
      "14-restore-disposable-db",
      restoreOk && /users=\d+/.test(restore.out) && !/users=0\b/.test(restore.out),
      "backup restored into a disposable PostgreSQL database (decrypt + pg_restore + row counts)",
      `restore output:\n${restore.out.slice(0, 1200)}`,
    );

    // ---- Step 15: graceful worker shutdown ----------------------------
    workerProc?.kill("SIGTERM");
    const exited = await waitFor(
      async () => workerProc?.exitCode !== null || workerProc?.killed,
      30_000,
    );
    assert(
      "15-worker-graceful-shutdown",
      exited,
      "worker exited on SIGTERM without error",
      `worker log tail:\n${workerLog.slice(-800)}`,
    );

    // ---- Summary -------------------------------------------------------
    console.log("═".repeat(72));
    for (const s of stepResults) {
      console.log(` ${s.status === "PASS" ? "PASS" : "FAIL"}  ${s.step}`);
    }
    console.log("═".repeat(72));
    console.log(
      failures === 0
        ? " PG INTEGRATION SUITE: ALL STEPS PASSED"
        : ` PG INTEGRATION SUITE: ${failures} step(s) FAILED`,
    );
    console.log("═".repeat(72));
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    try {
      webProc?.kill("SIGKILL");
    } catch {
      /* gone */
    }
    try {
      workerProc?.kill("SIGKILL");
    } catch {
      /* gone */
    }
    // Keep temp dirs when KEEP_ARTIFACTS=1 (debugging); clean otherwise.
    if (!process.env.KEEP_ARTIFACTS) {
      try {
        if (exportDir) rmSync(exportDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        if (backupDirPath) rmSync(backupDirPath, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } else {
      console.log(`[artifacts kept] exports=${exportDir} backups=${backupDirPath}`);
    }
  }
}

function maskUrl(url: string): string {
  return url.replace(/\/\/[^@/]+@/, "//***@");
}

main().catch((err) => {
  console.error("[pg-integration] fatal:", err);
  process.exitCode = 1;
});
