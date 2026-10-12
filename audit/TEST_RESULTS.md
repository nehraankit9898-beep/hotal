# Test Results — StayLoop audit (2026-10-11)

Status legend: **PASS** executed and passed · **FAIL** executed and failed · **BLOCKED** could not execute
(missing dependency or configuration) · **NOT RUN** not executed · **PARTIAL** only part of the coverage ran.

## Environment
- OS: Linux x64 sandbox · Node v22.22.3 · Bun 1.3.14 (installed globally from npm, matching CI `BUN_VERSION`)
- Dependencies: `bun install --frozen-lockfile` → **exit 0** (561 packages; lockfile not drifted)
- Prisma CLI 6.19.3. **The query engine and schema engine binaries cannot be downloaded**: `binaries.prisma.sh`
  is not on the allowed host list. Workaround used only to generate the TypeScript client:
  `PRISMA_SCHEMA_ENGINE_BINARY` / `PRISMA_QUERY_ENGINE_LIBRARY` pointed at placeholder files, which lets
  `prisma generate` run (it uses WASM). Any real database access then fails with "file too short".
- Not available: Docker, Redis server, PostgreSQL, a browser, Google Fonts (`fonts.googleapis.com`).

## Commands and results

| # | Command | Exit | Result | Status |
|---|---|---|---|---|
| 1 | `bun install --frozen-lockfile` | 0 | 561 packages installed | PASS |
| 2 | `bunx prisma generate --schema prisma/schema.prisma` (with stub engine env) | 0 | Client generated (SQLite schema) | PASS (with workaround) |
| 3 | `bun run typecheck` (`tsc --noEmit`) — **baseline** | 0 | no errors | PASS |
| 4 | `bun run typecheck` — **after fixes** | 0 | no errors (after fixing 3 test-file errors it introduced) | PASS |
| 5 | `bun run lint` (`eslint .`) — **after fixes** | 0 | no errors | PASS |
| 6 | `bun run scan:secrets` | 0 | "clean (no secrets detected in tracked files)" | PASS (tracked files only) |
| 7 | `npm install --package-lock-only` + `npm audit --omit=dev --audit-level=high` | 0 | found 0 vulnerabilities | PASS |
| 8 | `bun run build` (`next build`) | 1 | `next/font` could not fetch Geist / Geist Mono from Google Fonts (sandbox network). Failure is before any app compile step. | **BLOCKED** (environment) |
| 9 | `bun run test` (`scripts/run-tests.ts`) | 1 | Harness boots a Next dev server with SQLite. The seed step fails: "The Prisma engines do not seem to be compatible… file too short". No suite ran. | **BLOCKED** (Prisma engine) |
| 10 | `bun test tests/audit-2026-regressions.test.ts` | 0 | 13 pass, 0 fail | **PASS** |
| 11 | `bun test tests/deployment-config.test.ts` | 0 | 16 pass, 0 fail | PASS |
| 12 | `bun test tests/security-hardening.test.ts` | 0 | 10 pass, 0 fail | PASS |
| 13 | `bun test tests/crypto-rotation.test.ts` | 1 | 11 pass, 0 fail, then a load error | PARTIAL |
| 14 | `bun test tests/restore-args.test.ts` | 1 | 8 pass, 0 fail, then a load error | PARTIAL |
| 15 | `bun test tests/privacy-phone.test.ts` | 1 | 8 pass, 6 fail (2 connection errors; others need a server) | PARTIAL |
| 16 | Remaining 26 original `tests/*.test.ts` files | 1 | Fail at load (Prisma engine) or with "Unable to connect" to `localhost:3100` (no server) | **BLOCKED** |
| 17 | `scripts/test-phase1.ts`, `test-phase2.ts`, `test-phase63.ts` | — | **NOT RUN** (need a server and database) | NOT RUN |
| 18 | Migrations on PostgreSQL 16 (`prisma migrate deploy`, `migrate diff`) | — | **NOT RUN**: no PostgreSQL, and the schema engine cannot be downloaded | BLOCKED |
| 19 | Browser / E2E tests | — | **NOT RUN**: no browser tooling and no running database | NOT RUN |
| 20 | Trivy / Docker build | — | **NOT RUN**: no Docker | BLOCKED |

### Regression tests added by this audit (`tests/audit-2026-regressions.test.ts`)
| Test | Result on original code | Result with fixes |
|---|---|---|
| SEC-001 HOTEL_ADMIN cannot act on HOTEL_OWNER (pure rank function) | not applicable (new function) | PASS |
| SEC-001 HOTEL_OWNER may act on owner; admins still manage non-owners | not applicable | PASS |
| SEC-001 staff route calls the guard before any mutation (source wiring) | **FAIL** | PASS |
| SEC-005 normal small JSON body parses | PASS (new `body.ts`) | PASS |
| SEC-005 chunked body over 1 MB with no Content-Length → null | PASS (tests new module, see note) | PASS |
| SEC-005 oversize declared Content-Length → null | PASS (new module) | PASS |
| SEC-005 malformed JSON → null, no throw | PASS | PASS |
| SEC-005 readBodyCapped in-cap text | PASS | PASS |
| SEC-004 `isTest()` false under NODE_ENV=production + STAYLOOP_TEST=1 | **FAIL** | PASS |
| SEC-006 cross-origin POST with cookie session → CSRF_ORIGIN_MISMATCH | not run against original | PASS |
| SEC-006 logout calls `assertCsrf` before `tokenVersion` bump (source) | not run against original | PASS |
| FIN-001 webhook: try/catch → delete dedupe row → re-throw (source) | **FAIL** | PASS |

Verification of the "fails on original" column: `git stash push` of the four modified tracked source files
(`api-helpers.ts`, `config.ts`, `staff/[id]/route.ts`, `webhooks/razorpay-restaurant/route.ts`), then
`bun test tests/audit-2026-regressions.test.ts` → **3 fail, 8 pass**; `git stash pop` restored the changes.
Note: the SEC-005 tests exercise the new `src/lib/body.ts` module, so they pass against both versions. The original
`readJson` defect was confirmed by reading the code, not by a failing test. SEC-006 was not re-run against the
original because the test file imports the new code; its check was verified by reading the original route.

## Baseline suite status (before any change)
Per-file results from running each of the 31 original `tests/*.test.ts` files on the original commit: 2 files passed fully (`deployment-config` 16/16, `security-hardening` 10/10); `crypto-rotation` (11), `restore-args` (8) and `privacy-phone` (8 of 14) passed only some tests before a load or connection error, and no DB- or server-backed suite completed.
Full per-file table: `audit/REMAINING_RISKS.md` §5. Summary: **no DB-backed or server-backed
test ran to completion in this sandbox.**

## How to reproduce (on a machine with network access to the Prisma CDN)
```bash
bun install --frozen-lockfile
bunx prisma generate --schema prisma/schema.prisma
bun run typecheck && bun run lint && bun run scan:secrets
bun test tests/audit-2026-regressions.test.ts          # no server or DB needed
bun run test                                           # full suite; needs working Prisma engines + Redis
DATABASE_URL=file:../db/ci.db bun run build            # needs fonts.googleapis.com reachable
python3 audit/tools/generate_inventory.py              # regenerates ROUTE_INVENTORY + ROLE_PERMISSION_MATRIX
```
