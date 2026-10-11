# StayLoop — production images (Next.js standalone output + background worker).
#
# Build:  docker build --target web -t stayloop-web .       (web is NOT the
#         default target — the LAST stage in this file is admin-bootstrap, so
#         a build WITHOUT --target produces the ADMIN image, not web)
#         docker build --target worker -t stayloop-worker .
#         docker build --target admin-bootstrap -t stayloop-admin .
#
# Run:    see docker-compose.prod.yml — secrets come from the environment only.
#
# Layout notes (audit fix 1A): the runner copies the CONTENTS of
# .next/standalone into /app, so the server entrypoint is /app/server.js —
# NOT /app/.next/standalone/server.js. CMD below matches the real layout.
#
# Targets:
#   deps            — install (frozen lockfile) + Prisma client generation
#   builder         — Next.js production build (no secrets, no live DB)
#   web             — standalone Next.js server (default), UID 1001
#   worker          — standalone background worker + pg_dump (backups), UID 1001
#   migrate         — one-shot `prisma migrate deploy`, UID 1001
#   admin-bootstrap — one-shot first-super-admin bootstrap script, UID 1001

# ---------- 1. Dependencies + Prisma client ----------
FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY package.json bun.lock ./
# Frozen install: any lockfile drift fails the build instead of shipping
# unreviewed dependency changes.
RUN bun install --frozen-lockfile
# PostgreSQL is the production database: the Postgres Prisma client is the
# one generated for ALL production services (web, worker, migrate, admin).
# Dev SQLite keeps its own schema (prisma/schema.prisma) outside the image.
# AUDIT FIX (deploy-1): `COPY prisma ./` copied the CONTENTS of the prisma/
# directory into /app (so the schema landed at /app/schema.postgres.prisma)
# while the generate step below expects /app/prisma/schema.postgres.prisma —
# the build failed at the FIRST stage. Copying into ./prisma/ preserves the
# directory layout the command (and every later stage) relies on.
COPY prisma ./prisma/
RUN bunx prisma generate \
    --schema prisma/schema.postgres.prisma

# ---------- 2. Build the Next.js standalone bundle ----------
FROM oven/bun:1.3.14 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time env: only non-secret configuration (secrets are runtime-only).
# The build uses the DEV SQLite URL purely so Next can prerender pages —
# no production secrets or live database are required at build time
# (audit fix 1E: the image must build without production secrets).
RUN DATABASE_URL="file:../db/build.db" \
    bunx prisma generate --schema prisma/schema.postgres.prisma \
    && bun run build

# ---------- 3. Shared runtime base (non-root, PostgreSQL client) ----------
# pg_dump/pg_restore are needed wherever backups execute (worker). The
# PostgreSQL client is installed via the official pgdg repository so the
# pg_dump major version matches the postgres:16 service.
FROM oven/bun:1.3.14-slim AS runtime-base
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PGHOST=postgres \
    PGPORT=5432 \
    PGUSER=stayloop

# Install PostgreSQL 16 client tools (pg_dump / pg_restore / psql) from the
# official PostgreSQL apt repository, then drop apt caches to keep the image
# small. `--no-install-recommends` avoids pulling in extra services.
# The pgdg suite is derived from the base image's Debian codename so this
# works on both bookworm- and trixie-based bun images.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo $VERSION_CODENAME)-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-16 \
    && apt-get purge -y gnupg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Non-root identity shared by web + worker (files written by the worker are
# readable by the web server — same UID/GID, no 0777 anywhere).
RUN addgroup --system --gid 1001 stayloop \
    && adduser --system --uid 1001 stayloop

# Shared runtime directories (named volumes inherit this ownership on first
# use — explicitly initialized permissions, audit fix 2).
RUN mkdir -p /app/var/exports /app/var/backups \
    && chown -R stayloop:stayloop /app/var \
    && chmod 0750 /app/var/exports /app/var/backups

# ---------- 4. web: the Next.js standalone server ----------
FROM runtime-base AS web
COPY --from=builder --chown=stayloop:stayloop /app/.next/standalone ./
COPY --from=builder --chown=stayloop:stayloop /app/.next/static ./.next/static
COPY --from=builder --chown=stayloop:stayloop /app/public ./public
# Prisma schema + engine binaries for the migrate service (same image target)
COPY --from=builder --chown=stayloop:stayloop /app/prisma ./prisma

USER stayloop
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health/live || exit 1

# AUDIT FIX 1A: standalone contents are copied INTO /app, so the entrypoint
# is /app/server.js (the old CMD pointed at .next/standalone/server.js which
# does not exist in this image → container exited immediately).
CMD ["bun", "server.js"]

# ---------- 5. worker: the background job consumer ----------
# Runs the REAL source worker (scripts/worker.ts imports src/lib/*), not a
# traced copy: the whole src tree + generated Prisma client ship here.
FROM runtime-base AS worker
COPY --from=deps --chown=stayloop:stayloop /app/node_modules ./node_modules
COPY --from=builder --chown=stayloop:stayloop /app/src ./src
COPY --from=builder --chown=stayloop:stayloop /app/scripts ./scripts
COPY --from=builder --chown=stayloop:stayloop /app/prisma ./prisma
COPY --from=builder --chown=stayloop:stayloop /app/package.json ./package.json
COPY --from=builder --chown=stayloop:stayloop /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=stayloop:stayloop /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=stayloop:stayloop /app/bun.lock ./bun.lock

USER stayloop

# Observable health: the worker writes /tmp/worker-heartbeat.json every 30s;
# the healthcheck fails when the file is older than 90s (a wedged loop is
# detected even though the process still exists — audit fix 5).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "const fs=require('fs');try{const h=JSON.parse(fs.readFileSync('/tmp/worker-heartbeat.json','utf8'));process.exit(Date.now()-h.at<90000?0:1)}catch{process.exit(1)}"

CMD ["bun", "scripts/worker.ts"]

# ---------- 6. migrate: one-shot schema migration runner ----------
FROM runtime-base AS migrate
COPY --from=deps --chown=stayloop:stayloop /app/node_modules ./node_modules
COPY --from=builder --chown=stayloop:stayloop /app/prisma ./prisma
COPY --from=builder --chown=stayloop:stayloop /app/package.json ./package.json

USER stayloop
# prisma migrate deploy is non-destructive: it only applies pending
# migrations (never reset, never db push --accept-data-loss).
CMD ["bunx", "prisma", "migrate", "deploy", "--schema", "prisma/schema.postgres.prisma"]

# ---------- 7. admin-bootstrap: one-shot first super admin ----------
# AUDIT FIX 1B: the web image does not ship scripts/, so the documented
# `docker compose run --rm web bun scripts/bootstrap-admin.ts` could never
# work. This dedicated target ships the bootstrap script and REQUIRES
# operator-supplied --name/--email (see docker-compose.prod.yml `admin`
# profile service).
FROM runtime-base AS admin-bootstrap
COPY --from=deps --chown=stayloop:stayloop /app/node_modules ./node_modules
COPY --from=builder --chown=stayloop:stayloop /app/src ./src
COPY --from=builder --chown=stayloop:stayloop /app/scripts ./scripts
COPY --from=builder --chown=stayloop:stayloop /app/prisma ./prisma
COPY --from=builder --chown=stayloop:stayloop /app/package.json ./package.json
COPY --from=builder --chown=stayloop:stayloop /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=stayloop:stayloop /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=stayloop:stayloop /app/bun.lock ./bun.lock

USER stayloop
# AUDIT FIX (deploy-3): `docker compose run --rm admin --name "X" --email y`
# appends its arguments to ENTRYPOINT. With only a CMD, those arguments
# would REPLACE the command and the container would fail with
# `exec: "--name": executable file not found`. An explicit ENTRYPOINT keeps
# the documented compose command working; the script itself still fails
# closed when ADMIN_BOOTSTRAP_SECRET is missing/empty.
ENTRYPOINT ["bun", "scripts/bootstrap-admin.ts"]
