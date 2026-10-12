/**
 * Regression — module-load order in the RBAC import cycle.
 *
 * The three modules form a cycle:
 *
 *   src/lib/permissions.ts  ──(jsonError)──▶  src/lib/api-helpers.ts
 *            ▲                                          │
 *            │                              (resolveUserPermissions)
 *            │                                          ▼
 *            └──────────(PERMISSIONS)──────  src/lib/custom-roles.ts
 *
 * A cycle is survivable as long as nothing READS a cyclic import while the
 * owning module is still initializing. `custom-roles.ts` used to build its
 * `ALLOWED_CUSTOM_PERMISSIONS` set at module scope from `PERMISSIONS`, so
 * whenever `permissions.ts` was the first module of the three to be evaluated
 * the whole graph died with:
 *
 *   ReferenceError: Cannot access 'PERMISSIONS' before initialization
 *
 * That is exactly what `tests/unit.test.ts` does (it imports
 * `@/lib/permissions` before anything that pulls in `api-helpers`), so the
 * security suite could not even load — `bun run test` (and CI) failed on a
 * file whose 27 assertions never ran. Any route, script or worker chunk that
 * happened to list the `@/lib/permissions` import first would 500 the same way.
 *
 * The check runs in a CHILD process on purpose: module evaluation order is
 * per-process, so the entry module has to be controlled, and a poisoned module
 * registry must not leak into the rest of the suite.
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const TDZ_MESSAGE = "Cannot access 'PERMISSIONS' before initialization";

/** Run `script` in a fresh bun process and return { status, stdout, stderr }. */
function runInChild(script: string) {
  const run = spawnSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      STAYLOOP_TEST: "1",
      DATABASE_URL: process.env.DATABASE_URL ?? "file:/tmp/stayloop-cycle-check.db",
    },
  });
  return { status: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

describe("RBAC import cycle (permissions ↔ api-helpers ↔ custom-roles)", () => {
  test("importing @/lib/permissions FIRST loads the whole cycle", () => {
    const res = runInChild(`
      const permissions = await import("@/lib/permissions");
      if (!Array.isArray(permissions.PERMISSIONS) || permissions.PERMISSIONS.length === 0) {
        throw new Error("PERMISSIONS catalog is empty");
      }
      const customRoles = await import("@/lib/custom-roles");
      if (typeof customRoles.validateCustomRolePermissions !== "function") {
        throw new Error("custom-roles did not export its validator");
      }
      if (typeof permissions.requirePermission !== "function") {
        throw new Error("permissions did not export requirePermission");
      }
      console.log("CYCLE_LOADED");
      process.exit(0);
    `);
    expect(res.stderr).not.toContain(TDZ_MESSAGE);
    expect(res.stdout).toContain("CYCLE_LOADED");
  });

  test("the custom-role allowlist is fully populated after the lazy build", () => {
    const res = runInChild(`
      await import("@/lib/permissions");
      const { validateCustomRolePermissions } = await import("@/lib/custom-roles");
      const owner = ["CUSTOMER_READ", "INVENTORY_READ"];
      const ok = validateCustomRolePermissions(["CUSTOMER_READ"], "HOTEL_OWNER", owner);
      if (!ok.ok) throw new Error("grantable permission was rejected: " + ok.error);
      // Reserved permissions must STILL be refused — the lazy build must not
      // weaken the defense-in-depth allowlist.
      for (const reserved of ["SUPER_ADMIN_ACCESS", "BILL_REFUND", "TAX_MANAGE", "STAFF_MANAGE"]) {
        const denied = validateCustomRolePermissions([reserved], "HOTEL_OWNER", [reserved]);
        if (denied.ok) throw new Error("reserved permission became grantable: " + reserved);
      }
      console.log("ALLOWLIST_OK");
      process.exit(0);
    `);
    expect(res.stderr).not.toContain(TDZ_MESSAGE);
    expect(res.stdout).toContain("ALLOWLIST_OK");
  });

  test("custom-roles.ts reads the PERMISSIONS catalog lazily, not at module scope", () => {
    const src = readFileSync(join(ROOT, "src/lib/custom-roles.ts"), "utf8");
    // The historical crash was a module-scope `new Set(PERMISSIONS.filter(...))`.
    // Guard against it coming back: every read of the catalog must happen at
    // brace depth > 0, i.e. inside a function body, so it can never run while
    // `permissions.ts` is still initializing.
    let depth = 0;
    let inLineComment = false;
    let inBlockComment = false;
    const offenders: string[] = [];
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      const next = src[i + 1];
      if (inLineComment) {
        if (ch === "\n") inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          i++;
        }
        continue;
      }
      if (ch === "/" && next === "/") {
        inLineComment = true;
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i++;
        continue;
      }
      // Braces only: a call paren (`new Set(PERMISSIONS.filter(...))`) must
      // not count as "inside a function body".
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (src.startsWith("PERMISSIONS.filter", i) || src.startsWith("PERMISSIONS.map", i)) {
        const line = src.slice(0, i).split("\n").length;
        if (depth === 0) offenders.push(`line ${line} reads PERMISSIONS at module scope`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every src/lib module imports cleanly in a FRESH process (no TDZ cycle anywhere)", async () => {
    const dirs = ["src/lib", "src/lib/saas", "src/lib/ai", "src/lib/jobs", "src/lib/providers"];
    const files: string[] = [];
    for (const dir of dirs) {
      for (const f of readdirSync(join(ROOT, dir))) {
        if (f.endsWith(".ts")) files.push(`./${dir}/${f}`);
      }
    }
    expect(files.length).toBeGreaterThan(50); // sanity: the sweep really covered src/lib

    // Module evaluation order is per-process, so each module gets its own
    // child: that is the only way to observe "this file crashes when it is
    // the first one of its cycle to load".
    const offenders: string[] = [];
    const queue = files.sort();
    const worker = async (): Promise<void> => {
      for (;;) {
        const file = queue.shift();
        if (!file) return;
        const proc = Bun.spawn(
          [process.execPath, "-e", `await import(${JSON.stringify(file)}); process.exit(0);`],
          {
            cwd: ROOT,
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...process.env,
              NODE_ENV: "test",
              STAYLOOP_TEST: "1",
              DATABASE_URL: process.env.DATABASE_URL ?? "file:/tmp/stayloop-cycle-check.db",
            } as Record<string, string>,
          },
        );
        const stderr = await new Response(proc.stderr).text();
        await proc.exited;
        if (stderr.includes("before initialization")) {
          offenders.push(
            `${file}: ${stderr.split("\n").find((l) => l.includes("before initialization"))}`,
          );
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    expect(offenders).toEqual([]);
  }, 120_000);
});
