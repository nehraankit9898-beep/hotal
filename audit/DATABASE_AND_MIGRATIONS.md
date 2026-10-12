# Database and migrations — 2026-10-12

Detailed earlier static schema review: `audit/DATABASE_AND_MIGRATION_AUDIT.md`. SQLite schema: `prisma/schema.prisma`; PostgreSQL schema/migration target: `prisma/schema.postgres.prisma` and 12 `prisma/migrations/*/migration.sql` files. Prisma 6.19.3 (from package). NO schema change or migration in this repair; custom grants use existing `CustomRole` and `CustomRoleAssignment`. Existing applied migrations were not edited. `bunx prisma generate --schema prisma/schema.prisma`, `bunx prisma validate --schema prisma/schema.prisma`, and disposable `bun run test` db push all failed before accessing a database because `binaries.prisma.sh` schema-engine download was blocked. Thus fresh creation, upgrade, schema drift, FK, and restoration are **BLOCKED/NOT TESTED** (not PASS).

Safe reproduction in an egress-approved isolated environment:
```
bun install --frozen-lockfile
bunx prisma generate --schema prisma/schema.prisma
bun run test                         # makes a disposable SQLite DB in /tmp
# On an isolated PostgreSQL 16 database with credentials supplied by operator:
bunx prisma generate --schema prisma/schema.postgres.prisma
bunx prisma migrate deploy --schema prisma/schema.postgres.prisma
# Then run CI's shadow-database migration diff (see .github/workflows/ci.yml).
```
Do NOT use `db:reset`, `db:push:force`, or point tests at production. Rollback is not applicable to this change (no migration); forward recovery: restore authorized network access to pinned Prisma engines, regenerate client, rerun quality/DB tests.
