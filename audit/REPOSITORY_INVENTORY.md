# Repository Inventory — StayLoop (2026-10-11)

Snapshot: commit `b398b81`, branch `arena/4731a2f4-hotal`. 512 tracked files at the start of the audit.

## Stack (confirmed from `package.json` and source)
| Item | Value | Source |
|---|---|---|
| Framework | Next.js **16.4.0** (App Router) | `package.json` |
| UI | React **^19**, Tailwind **^4**, Radix UI, Recharts, Framer Motion | `package.json` |
| Language | TypeScript **^5** | `package.json`, `tsconfig.json` |
| ORM | Prisma **6.19.3** (`@prisma/client` pinned) | `package.json` |
| Databases | SQLite (dev, `prisma/schema.prisma`) · PostgreSQL 16 (prod, `prisma/schema.postgres.prisma`) | README, CI |
| Validation | Zod **4.6.5** (pinned) | `package.json` |
| Cache / rate limit / queue | Redis via **ioredis ^6** (`REDIS_URL`) | `package.json`, `src/lib/queue.ts`, `src/lib/rate-limit.ts` |
| Runtime | **Bun 1.3.14** (dev, test, worker); Node-compatible standalone build (`bun .next/standalone/server.js`) | CI `BUN_VERSION`, Dockerfile, `package.json` |
| Package manager | **bun** (`bun.lock`, `--frozen-lockfile` in CI). `package-lock.json` is NOT committed; CI generates one with npm for the audit step. | CI |
| Email | nodemailer ^10 (SMTP) · Resend · SendGrid (env-selected) | `src/lib/providers/email.ts`, `.env.example` |
| Payments | Razorpay (restaurant + SaaS), Stripe (SaaS). Provider SDKs not used; HTTP integration. | `src/lib/billing.ts`, `src/app/api/billing/webhook/[provider]` |
| Other external | WhatsApp Cloud API, Twilio (env vars present) | `.env.example` |
| Container | `oven/bun:1.3.14` builder + slim runtime, non-root user `stayloop` | `Dockerfile` |
| Reverse proxy | Caddy (automatic TLS, HSTS, nosniff) | `Caddyfile` |
| CI | GitHub Actions `.github/workflows/ci.yml`: jobs `quality-and-security`, `postgres-migrations`, `postgres-integration`, `docker` | CI file |

## Tracked file counts by area
| Area | Files | Notes |
|---|---|---|
| `src/lib` | 69 (+11 in `saas`, 6 in `ai`, 2 in `providers`, 1 in `jobs`) | Domain logic, auth, billing, RBAC |
| `src/components/app` | 54 | Product UI views |
| `src/components/ui` | 48 | shadcn/ui primitives |
| `src/components/public` | 4 | Public menu / QR pages |
| `src/app/api` | **202** `route.ts` files | See `ROUTE_INVENTORY.md` |
| `src/app` pages | **8** `page.tsx` | activate, forgot-password, menu/[code], root, pay/[token], r/[code], reset-password, verify-email |
| `tests` | 33 tracked at start (31 `*.test.ts` + `helpers.ts` + `queue-test-env.ts`); this audit adds `audit-2026-regressions.test.ts` | See `TEST_RESULTS.md` |
| `scripts` | 20 | seed, bootstrap, worker, backup/restore, scans, test runners, cleanup |
| `prisma` | 2 schemas, **11** migrations (+ lock) | 0001 … 0011 |
| `docs` | 10 | ARCHITECTURE, SECURITY, ENVIRONMENT, DATABASE, BACKUP, DR, INCIDENT, OPERATIONS, SECRET_ROTATION, DEPLOYMENT |
| root docs | DEPLOYMENT.md, LAUNCH_CHECKLIST.md, README.md | Deployment and launch guidance |
| CI / infra | `.github/workflows/ci.yml`, `Dockerfile`, `docker-compose.prod.yml`, `Caddyfile`, `.dockerignore` | |

## Documentation read
- `README.md`: first ~120 lines read (stack, quick start, scripts, production minimum). The rest was not read.
- `docs/SECURITY.md`: section headers and the claims checked in `FUNCTIONAL_BUGS.md` (DOC-001).
- `docs/DATABASE.md`: dev/test `db push` vs production `migrate deploy` guidance (lines 10–16).
- Not read in full in this pass: `docs/ARCHITECTURE.md`, `docs/ENVIRONMENT.md`, `docs/BACKUP_AND_RESTORE.md`,
  `docs/DISASTER_RECOVERY.md`, `docs/INCIDENT_RESPONSE.md`, `docs/OPERATIONS.md`, `docs/SECRET_ROTATION.md`,
  `DEPLOYMENT.md`, `LAUNCH_CHECKLIST.md`. The `.env.example` keys were checked against the code (names only).
- Note: the audit prompt refers to SECURITY.md, ARCHITECTURE.md, ENVIRONMENT.md, and DATABASE.md at the root. They are in `docs/`.

## Dangerous scripts (inventory only, NOT executed)
| Script | Command | Risk |
|---|---|---|
| `db:push:force` | `prisma db push --accept-data-loss` | Destructive; dev only |
| `db:reset` | `prisma migrate reset --schema prisma/schema.postgres.prisma` | Destroys the target database |
| `cleanup` | `scripts/cleanup-reseed.ts` | Deletes and reseeds data |
| `restore:backup` | `scripts/restore-backup.ts` | Overwrites data from an encrypted archive |
| `seed` / `seed:63` | seed scripts | Writes demo data and fixed demo credentials in dev |
| `bootstrap:admin` | `scripts/bootstrap-admin.ts` | Creates the first SUPER_ADMIN |

None of these were run against any database in this audit.

## Git status at start
- Branch: `arena/4731a2f4-hotal`, clean working tree.
- Existing branches are not used by this session.
