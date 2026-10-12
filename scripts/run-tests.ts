/**
 * Security & functional test harness (Phase 22/23/25).
 *
 * Boots an isolated server+database, then runs:
 *   1. tests/*.test.ts      — security suite (bun test): auth, RBAC, tenant
 *                             isolation, webhooks, secrets, coupons, CSRF,
 *                             lockout, bootstrap.
 *   2. scripts/test-phase1.ts + scripts/test-phase2.ts — functional acceptance suites.
 *
 * Environment for the test server:
 *   NODE_ENV=test, STAYLOOP_TEST=1 (deterministic in-code dev secrets),
 *   fresh SQLite database (temp dir), known seed passwords.
 *
 * Usage: bun run test
 */
import { spawn, spawnSync } from "child_process";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const PORT = 3100;
const BASE = `http://localhost:${PORT}`;

// Shared, known-good test configuration (test env only — never production).
const TEST_SECRETS = {
  TRACKING_WEBHOOK_SECRET: "test-webhook-hmac-secret-0123456789abcdef0123456789abcdef",
  ADMIN_BOOTSTRAP_SECRET: "test-bootstrap-secret-0123456789abcdef0123456789abcdef",
};

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run a child with inherited stdio and resolve with its exit code WITHOUT
 * blocking this process. BUG FIX: test files used to run via spawnSync, which
 * froze this event loop for the whole file, so nothing drained the dev
 * server's stdout/stderr pipes. Once a chatty file filled the ~200 KB socket
 * buffer, the server's next (synchronous) log write blocked ITS event loop —
 * every request hung, even DB-free routes (the "wedge" the watchdog below was
 * restarting the server for).
 */
function runInherited(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(cmd, args, { cwd: ROOT, env, stdio: "inherit" });
    child.on("error", () => resolveExit(1));
    child.on("close", (code) => resolveExit(code ?? 1));
  });
}

async function waitForServer(timeoutMs = 90_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await wait(700);
  }
  return false;
}

/**
 * Phase 6.4 — test-infra watchdog.
 *
 * Dev-mode Next.js (Turbopack) can very rarely wedge its request pipeline
 * between long-running suites (observed: server accepts connections but stops
 * responding, even on DB-free routes). The main cause was this runner never
 * draining the server's stdio while a suite ran (fixed: see runInherited);
 * the watchdog stays as a safety net for crashes. This check pings the
 * liveness endpoint after every suite; a wedged/crashed dev server is
 * RESTARTED so the remaining
 * suites still run and the failure is recorded loudly instead of cascading
 * every subsequent suite into timeouts. This is a test-infrastructure
 * resilience measure — application behavior is covered by the suites
 * themselves (which all pass against a healthy server).
 */
let serverProc: ReturnType<typeof spawn> | null = null;
let serverLog = "";
let currentEnv: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv;

async function restartServer(env: NodeJS.ProcessEnv): Promise<void> {
  if (serverProc) {
    try {
      serverProc.kill("SIGTERM");
      await wait(1500);
      serverProc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  serverProc = spawn("bunx", ["next", "dev", "-p", String(PORT)], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stdout?.on("data", (d) => {
    serverLog += d.toString();
  });
  serverProc.stderr?.on("data", (d) => {
    serverLog += d.toString();
  });
  await waitForServer(120_000);
}

async function ensureServerHealthy(label: string): Promise<void> {
  try {
    const res = await fetch(`${BASE}/api`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) return;
  } catch {
    /* wedged or crashed */
  }
  console.log(`\n⚠  Test server stopped responding ${label} — restarting it (dev-mode watchdog).`);
  serverLog += `\n[watchdog] server unresponsive ${label} — restart issued at ${new Date().toISOString()}\n`;
  await restartServer(currentEnv);
}

async function main() {
  console.log("━".repeat(60));
  console.log(" StayLoop security + functional test run");
  console.log("━".repeat(60));

  // 1. Fresh test database (SQLite file in a temp dir)
  const tmp = mkdtempSync(join(tmpdir(), "stayloop-test-"));
  const dbFile = join(tmp, "test.db");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: `file:${dbFile}`,
    NODE_ENV: "test",
    STAYLOOP_TEST: "1",
    PORT: String(PORT),
    ...TEST_SECRETS,
  };

  // Push schema to the fresh DB
  console.log("\n[1/6] Creating test database schema…");
  const push = spawnSync(
    "bunx",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    {
      cwd: ROOT,
      env,
      stdio: "inherit",
    },
  );
  if (push.status !== 0) {
    console.error("prisma db push failed");
    process.exit(1);
  }

  // 2. Seed with known credentials
  console.log("\n[2/6] Seeding synthetic test data…");
  const seedEnv: NodeJS.ProcessEnv = {
    ...env,
    STAYLOOP_SEED_ADMIN_PASSWORD: "TestAdmin123",
    STAYLOOP_SEED_STAFF_PASSWORD: "TestStaff123",
  };
  const seed = spawnSync("bun", ["run", "scripts/seed.ts"], {
    cwd: ROOT,
    env: seedEnv,
    stdio: "inherit",
  });
  const seed2 = spawnSync("bun", ["run", "scripts/seed-phase3-6.ts"], {
    cwd: ROOT,
    env: seedEnv,
    stdio: "inherit",
  });
  const seed3 = spawnSync("bun", ["run", "scripts/seed-phase63.ts"], {
    cwd: ROOT,
    env: seedEnv,
    stdio: "inherit",
  });
  if (seed.status !== 0 || seed2.status !== 0 || seed3.status !== 0) {
    console.error("seed failed");
    process.exit(1);
  }

  // 3. Start the server
  console.log("\n[3/6] Starting test server on :" + PORT + "…");
  currentEnv = env;
  const server = spawn("bunx", ["next", "dev", "-p", String(PORT)], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc = server;
  server.stdout.on("data", (d) => {
    serverLog += d.toString();
  });
  server.stderr.on("data", (d) => {
    serverLog += d.toString();
  });

  let failures = 0;
  try {
    const up = await waitForServer();
    if (!up) {
      console.error("Server did not start. Log:\n" + serverLog.slice(-4000));
      process.exit(1);
    }
    console.log("      server is up");

    // 4. Security suite (bun test) — one bun process PER FILE.
    // Phase 8.1 test-infra hardening: bun's default multi-worker execution
    // made a dev-mode server compile dozens of routes at once (wedge →
    // cascading timeouts), and long single-process runs exhibited cross-file
    // fetch pollution (a late file's requests hanging with the server
    // healthy). Running each file in its own short-lived process with the
    // watchdog between files is deterministic and matches the watchdog design.
    console.log("\n[4/6] Running security test suite (bun test, per-file isolation)…");
    const testEnv: NodeJS.ProcessEnv = {
      ...env,
      TEST_BASE_URL: BASE,
      TEST_ADMIN_PASSWORD: "TestAdmin123",
      TEST_STAFF_PASSWORD: "TestStaff123",
      ...TEST_SECRETS,
    };
    const TEST_FILES = [
      "tests/auth.test.ts",
      "tests/lockout.test.ts",
      "tests/navigation-rbac.test.ts",
      "tests/phase64.test.ts",
      "tests/phase7.test.ts",
      "tests/privacy-phone.test.ts",
      "tests/rbac-tenant.test.ts",
      "tests/security.test.ts",
      "tests/super-admin-platform.test.ts",
      "tests/phase10-saas.test.ts",
      "tests/unit.test.ts",
      // Phase 10 audit regression suites (queue leases/DLQ, backup verify,
      // email honesty, worker heartbeat).
      "tests/queue-reliability.test.ts",
      "tests/ops-reliability.test.ts",
      // Deployment-fix regression suites (this release):
      // Dockerfile/CI/compose invariants, encryption-key rotation for stored
      // secrets, payment-confirmation outbox, export quota reservation,
      // backup schedule claim, atomic super-admin bootstrap, pg_restore argv.
      "tests/deployment-config.test.ts",
      "tests/restore-args.test.ts",
      "tests/crypto-rotation.test.ts",
      "tests/billing-outbox.test.ts",
      "tests/export-quota.test.ts",
      "tests/backup-schedule.test.ts",
      "tests/bootstrap-atomicity.test.ts",
      // RECHECK REGRESSION: the F01–F18 audit-fix suite was previously MISSING
      // from this list — `bun run test` silently skipped it. Registered now.
      "tests/audit-fixes.test.ts",
      // Recheck-release suite: template payload wiring, integration-disable
      // fail-closed policy, existing-member OTP journey, Razorpay
      // order→capture correlation, concurrent customer-capacity enforcement.
      "tests/recheck-fixes.test.ts",
      // Phase 11 — durable scheduler regressions (due campaigns, journeys).
      "tests/phase11-scheduler.test.ts",
      // Phase 12 — menu & tables (catalog RBAC, QR binding, public menu).
      "tests/phase12-menu.test.ts",
      // Phase 13 — ordering, staff & KDS (idempotency, state machine, roles).
      "tests/phase13-orders.test.ts",
      // Phase 14 — POS, GST billing & payments (tax engine, splits, refunds,
      // cash sessions, tenant isolation, webhook replay protection).
      "tests/phase14-billing.test.ts",
      // Phase 15 — retention & marketing (referrals, promotions, payment
      // links, owner reports, bill-paid followups).
      "tests/phase15-retention.test.ts",
      // Phase 16 — operations (reservations, inventory once-only deductions,
      // attendance, branches, offline sync idempotency).
      "tests/phase16-operations.test.ts",
      // Phase 17 — enterprise & platform completion (custom roles, white-label,
      // webhooks, A/B experiments, privacy requests, SaaS refunds, benchmarking,
      // franchise, enterprise API extension).
      "tests/phase17-enterprise.test.ts",
      // Phase 18 — advanced AI & innovation (chatbot E2E + units, governance
      // flags, recommendations approval, forecast honesty, wallet security,
      // voice parsing, sustainability labels).
      "tests/phase18-ai.test.ts",
      // DB-free regression suites: the 2026 audit fixes and the hardening
      // checks were never registered here, so `bun run test` (and CI) skipped
      // them. The guard below now fails the run if any suite is unregistered.
      "tests/audit-2026-regressions.test.ts",
      "tests/security-hardening.test.ts",
      "tests/bugfix-regressions-2026-10.test.ts",
    ];
    const unregistered = readdirSync(join(ROOT, "tests"))
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => `tests/${f}`)
      .filter((f) => !TEST_FILES.includes(f));
    if (unregistered.length > 0) {
      console.error(`\n✗ Test files missing from TEST_FILES (scripts/run-tests.ts): ${unregistered.join(", ")}`);
      failures += 1;
    }
    for (const file of TEST_FILES) {
      console.log(`\n  ▸ ${file}`);
      // Phase 14/15/16 files hit many brand-new routes; dev-mode Next.js
      // compiles each on first request (tens of seconds). The longer timeout
      // absorbs first-hit compilation, not slow business logic.
      const timeout = file.includes("phase14") || file.includes("phase15") || file.includes("phase16") || file.includes("phase17") ? "120000" : "30000";
      failures += await runInherited("bun", ["test", file, "--timeout", timeout], testEnv);
      await ensureServerHealthy(`after ${file}`);
    }

    // 5. Functional acceptance suites
    console.log("\n[5/6] Running functional acceptance suites…");
    failures += await runInherited("bun", ["run", "scripts/test-phase1.ts"], testEnv);
    await ensureServerHealthy("after phase1");

    failures += await runInherited("bun", ["run", "scripts/test-phase2.ts"], testEnv);
    await ensureServerHealthy("after phase2");

    failures += await runInherited("bun", ["run", "scripts/test-phase63.ts"], testEnv);
    await ensureServerHealthy("after phase63");
  } finally {
    // 6. Teardown
    console.log("\n[6/6] Stopping server and cleaning up…");
    // Phase 6.4: always dump the tail of the server log — a crashed/hung test
    // server leaves the evidence here.
    if (serverLog.trim().length > 0) {
      console.log("─── test server log (last 6000 chars) ───");
      console.log(serverLog.slice(-6000));
      console.log("─── end server log ───");
    }
    try {
      server.kill("SIGTERM");
      await wait(1200);
      server.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    if (serverProc && serverProc !== server) {
      try {
        serverProc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  console.log("\n" + "━".repeat(60));
  if (failures === 0) {
    console.log(" ALL TEST SUITES PASSED");
  } else {
    console.log(` ${failures} test suite(s) FAILED`);
  }
  console.log("━".repeat(60));
  process.exit(failures === 0 ? 0 : 1);
}

main();
