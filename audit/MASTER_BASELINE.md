# StayLoop master baseline — 2026-10-12

Source checkout: `ea029bea7ff77bdc6667d4fa020268b4dbe832eb` on `arena/8ada2bf9-hotal` (clean before edits). Historical reviews in `audit/REPOSITORY_INVENTORY.md`, `audit/ROUTE_INVENTORY.md`, `audit/INITIAL_BASELINE.md`, and `audit/BUG_SWEEP_2026-10.md` are **prior work, not evidence that this checkout passes**. See `FINAL_VERIFICATION_REPORT.md` for this pass.

- Next.js 16.4 App Router / React 19 / TypeScript 5.9; Bun 1.3.14 (`bun.lock`), Node installed for tooling (CI pins Bun, no Node engine field). 204 API route files, 8 page files, 414 source files at discovery. SQLite dev/test (`prisma/schema.prisma`), PostgreSQL production (`prisma/schema.postgres.prisma`); 12 migrations; Prisma 6.19.3. Test runner: `scripts/run-tests.ts`, `tests/*.test.ts`. Deployment: `Dockerfile`, `docker-compose.prod.yml`, `Caddyfile`, `.github/workflows/ci.yml`. Secrets reference: `.env.example`, `docs/ENVIRONMENT.md`. Docs: `README.md`, `DEPLOYMENT.md`, `docs/{DATABASE,SECURITY,BACKUP_AND_RESTORE}.md`.
- Search: `rg 'TODO|FIXME|placeholder|mock|demo|hardcoded|unimplemented|catch \\{\\}|as unknown as|\\.catch\\(\\(\\) => undefined\\)' src --stats` found 261 occurrences in 85 files (not all defects). No blanket conclusion from a regex search.

## Baseline commands before source edits

| Command | Actual result |
|---|---|
| `bun install --frozen-lockfile` | Initially unavailable: `bun: command not found`; installed Bun 1.3.14 from npm; then **PASS**, 561 packages. |
| `bunx prisma generate --schema prisma/schema.prisma` | **BLOCKED**: Prisma schema-engine download from `binaries.prisma.sh` failed (host not available here). Client remained ungenerated. |
| `bun run typecheck` | **FAIL**: 16 TS errors in billing receipt, customer/import, inventory, coupons, orders, etc., due to ungenerated Prisma client; not considered a pass. |
| `bun run lint` | **PASS**, exit 0. |
| `bun test tests/audit-2026-regressions.test.ts tests/security-hardening.test.ts` | **PASS**, 23 passed / 0 failed; DB-free tests only. |
| `bun run build` | **FAIL**, Google Fonts unavailable at build time; later fixed locally with OFL self-hosted fonts. |

No database was reset or production data accessed. `prisma db push` was attempted only through the disposable test harness after edits and failed before schema creation. Prisma binary/network availability remains an external blocker. No Docker, PostgreSQL, Redis or browser runtime was available/verified here.
