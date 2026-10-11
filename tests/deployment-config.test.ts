/**
 * Deployment configuration invariants — regression tests for the three
 * production deployment bugs fixed in this release (plus the compose
 * interpolation blocker):
 *
 *  A1. Dockerfile deps stage MUST copy prisma/ into ./prisma/ (the generate
 *      step expects /app/prisma/schema.postgres.prisma; `COPY prisma ./`
 *      flattened the directory and broke the ENTIRE docker build at stage 1).
 *  A2. Every `docker build` that tags the WEB image MUST pass --target web
 *      (the LAST Dockerfile stage is admin-bootstrap, so a target-less build
 *      produces the ADMIN image — CI scanned/deployed the wrong image).
 *  A3. The admin-bootstrap stage MUST define an ENTRYPOINT (the documented
 *      `compose run --rm admin --name X --email y` appends its arguments to
 *      ENTRYPOINT; with only a CMD the arguments REPLACE the command).
 *  A4. docker-compose.prod.yml MUST NOT use `${ADMIN_BOOTSTRAP_SECRET:?…}`
 *      required interpolation on the inactive-profile `admin` service —
 *      compose interpolates the whole file before profile filtering, so the
 *      documented "remove the secret after bootstrap" step broke every
 *      subsequent compose command (verified: `docker compose config` exits
 *      15 without the variable).
 *
 * These are static invariants (no Docker daemon required). When a compose
 * binary IS available (env DOCKER_COMPOSE_BIN, or `docker compose` on PATH),
 * the real `config` interpolation check runs as well.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const ROOT = resolve(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const dockerfile = read("Dockerfile");
const ci = read(".github/workflows/ci.yml");
const compose = read("docker-compose.prod.yml");
const deploymentDoc = read("DEPLOYMENT.md");

/** All build stage names in Dockerfile order. */
const stages = [...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gm)].map((m) => m[1]);

describe("A1 — Dockerfile deps stage copies prisma/ correctly", () => {
  test("deps stage uses `COPY prisma ./prisma/` (directory layout preserved)", () => {
    const depsSection = dockerfile.split(/AS deps\b/)[1]?.split(/^FROM /m)[0] ?? "";
    expect(depsSection).toContain("COPY prisma ./prisma/");
  });

  test("no flattening `COPY prisma ./` remains anywhere in the Dockerfile", () => {
    // Exact-line match: `COPY prisma ./` copies CONTENTS into /app and breaks
    // `prisma generate --schema prisma/schema.postgres.prisma`.
    expect(/^COPY prisma \.\/\s*$/m.test(dockerfile)).toBe(false);
  });

  test("the generate step that expects ./prisma/schema.postgres.prisma still exists", () => {
    const depsSection = dockerfile.split(/AS deps\b/)[1]?.split(/^FROM /m)[0] ?? "";
    expect(depsSection).toContain("--schema prisma/schema.postgres.prisma");
  });
});

describe("A2 — web image builds always pass --target web", () => {
  test("the LAST Dockerfile stage is admin-bootstrap (why --target is mandatory)", () => {
    expect(stages.length).toBeGreaterThan(0);
    expect(stages[stages.length - 1]).toBe("admin-bootstrap");
  });

  test("a `web` stage exists to target", () => {
    expect(stages).toContain("web");
  });

  test("CI builds the web image with --target web", () => {
    const buildLines = ci.split(/\r?\n/).filter((l) => /^\s*docker build\b/.test(l));
    expect(buildLines.length).toBeGreaterThanOrEqual(2);
    for (const line of buildLines) {
      if (/stayloop-web/.test(line)) {
        expect(line).toContain("--target web");
      }
      if (/stayloop-worker/.test(line)) {
        expect(line).toContain("--target worker");
      }
    }
  });

  test("documentation never shows a target-less build for the web image", () => {
    // README + DEPLOYMENT must not teach the broken command.
    for (const doc of [read("README.md"), deploymentDoc]) {
      const bad = doc
        .split(/\r?\n/)
        .filter((l) => /docker build\s+-t\s+stayloop-web/.test(l) && !/--target\s+web/.test(l));
      expect(bad).toEqual([]);
    }
  });
});

describe("A3 — admin-bootstrap is ENTRYPOINT-based (compose run args append)", () => {
  test("the admin-bootstrap stage defines the bootstrap ENTRYPOINT", () => {
    const adminSection = dockerfile.split(/AS admin-bootstrap\b/)[1] ?? "";
    expect(adminSection).toContain('ENTRYPOINT ["bun", "scripts/bootstrap-admin.ts"]');
  });

  test("the documented compose bootstrap command appends --name/--email", () => {
    // The command shape operators copy-paste from DEPLOYMENT.md §6 and the
    // compose header. With ENTRYPOINT semantics these become script args.
    expect(deploymentDoc).toContain("--profile admin run --rm admin");
    const cmd = deploymentDoc.split(/\r?\n/).filter((l) => l.includes("run --rm admin"));
    expect(cmd.length).toBeGreaterThanOrEqual(1);
    expect(deploymentDoc).toMatch(/--name\s+"Platform Admin"/);
    expect(deploymentDoc).toMatch(/--email\s+you@example\.com/);
  });
});

describe("A4 — ADMIN_BOOTSTRAP_SECRET does not block the stack (inactive profile)", () => {
  // Effective (non-comment) YAML lines only — explanatory comments may quote
  // the broken syntax they document.
  const composeEffective = compose
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  test("compose uses optional interpolation for ADMIN_BOOTSTRAP_SECRET", () => {
    // Required interpolation `:?` on ANY service makes compose fail at model
    // load time — even for services excluded by profiles.
    expect(composeEffective).not.toContain("${ADMIN_BOOTSTRAP_SECRET:?");
    expect(composeEffective).toContain("${ADMIN_BOOTSTRAP_SECRET:-}");
  });

  test("required interpolations remain only for always-on services", () => {
    // DATABASE_URL / DATABASE_PASSWORD / DOMAIN / ACME_EMAIL belong to
    // postgres/web/caddy — services that are ALWAYS active — where failing
    // without them is correct fail-closed behavior.
    for (const m of composeEffective.matchAll(/\$\{(\w+):\?[^}]*\}/g)) {
      expect(["DATABASE_URL", "DATABASE_PASSWORD", "DOMAIN", "ACME_EMAIL"]).toContain(m[1]);
    }
  });

  test("the admin service stays behind the admin profile", () => {
    const adminBlock = compose.split(/^  admin:/m)[1]?.split(/^  \w/m)[0] ?? "";
    expect(adminBlock).toContain('profiles: ["admin"]');
    expect(adminBlock).toContain("target: admin-bootstrap");
  });

  test("the web service builds the web target", () => {
    const webBlock = compose.split(/^  web:/m)[1]?.split(/^  \w/m)[0] ?? "";
    expect(webBlock).toContain("target: web");
  });

  // REAL interpolation check — runs when a compose binary is available
  // (local sandbox: DOCKER_COMPOSE_BIN=/path/to/compose; GitHub CI: docker).
  test("docker compose config succeeds WITHOUT ADMIN_BOOTSTRAP_SECRET (when binary available)", () => {
    const candidates: { cmd: string; args: string[] }[] = [];
    if (process.env.DOCKER_COMPOSE_BIN) {
      candidates.push({
        cmd: process.env.DOCKER_COMPOSE_BIN,
        args: ["-f", "docker-compose.prod.yml", "config", "--quiet"],
      });
    } else {
      candidates.push({
        cmd: "docker",
        args: ["compose", "-f", "docker-compose.prod.yml", "config", "--quiet"],
      });
      candidates.push({
        cmd: "docker-compose",
        args: ["-f", "docker-compose.prod.yml", "config", "--quiet"],
      });
    }

    let ran = false;
    let lastCode: number | null = null;
    for (const candidate of candidates) {
      const tmp = mkdtempSync(join(tmpdir(), "stayloop-compose-check-"));
      try {
        mkdirSync(join(tmp, "prisma"), { recursive: true });
        writeFileSync(join(tmp, "docker-compose.prod.yml"), compose);
        // .env WITHOUT ADMIN_BOOTSTRAP_SECRET — the documented post-bootstrap
        // state. Required vars for always-on services are provided.
        writeFileSync(
          join(tmp, ".env"),
          [
            "DATABASE_PASSWORD=testpassword0123456789abcdef",
            "DATABASE_URL=postgresql://stayloop:testpassword0123456789abcdef@postgres:5432/stayloop?schema=public",
            "DOMAIN=app.example.com",
            "ACME_EMAIL=ops@example.com",
            "",
          ].join("\n"),
        );
        const res = spawnSync(candidate.cmd, candidate.args, {
          cwd: tmp,
          encoding: "utf8",
          timeout: 60_000,
        });
        if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") continue; // not installed
        ran = true;
        lastCode = res.status;
        if (res.status !== 0) {
          console.error(
            "compose config failed:\n" + ((res.stdout ?? "") + (res.stderr ?? "")).slice(0, 1000),
          );
        }
        break;
      } finally {
        try {
          rmSync(tmp, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    }

    if (!ran) {
      console.log(
        "SKIP — no docker/compose binary available in this environment (static invariants above still apply)",
      );
      return;
    }
    expect(lastCode).toBe(0);
  });
});

describe("dockerignore / build context sanity", () => {
  test("prisma/ is NOT excluded from the build context", () => {
    const dockerignore = read(".dockerignore");
    const lines = dockerignore
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines.find((l) => l === "prisma" || l === "prisma/" || l === "/prisma")).toBeUndefined();
  });

  test("the prisma directory actually contains the Postgres schema", () => {
    expect(existsSync(join(ROOT, "prisma", "schema.postgres.prisma"))).toBe(true);
  });
});
