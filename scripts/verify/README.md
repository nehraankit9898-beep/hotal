# Feature verification probes

End-to-end HTTP probes that exercise the product against a **running** server.
They complement `bun run test` (unit/integration suites) with a
feature-by-feature smoke pass over the real API.

## Prerequisites

1. A dev server on the target port with a **seeded** database:
   ```bash
   bun run seed            # demo hotel + admin (admin@grandpalace.com / TestAdmin123)
   bunx next dev -p 3000 -H 0.0.0.0
   ```
2. Optionally start the background worker so queue-dependent features run:
   ```bash
   bun run scripts/worker.ts
   ```

## Running

```bash
PROBE_BASE=http://localhost:3000 bun run scripts/verify/route-sweep.ts
```

| Probe | What it covers | Last result |
| --- | --- | --- |
| `route-sweep.ts` | ~87 contract checks across every feature area (auth, CRM, loyalty, restaurant ops, POS, inventory, enterprise, AI, super-admin, RBAC) | **87/87** |
| `e2e.ts` | One full product journey: menu → QR → table session → public order → KDS → bill → partial + full payment → receipt → reservation → purchase order, plus RBAC and tenant isolation | **33/33** |
| `public-pages.ts` | Unauthenticated surface: QR landing pages, public menu JSON, guest feedback, invalid-QR handling, app shell | **9/9** |
| `feature-probe.ts` | Integration features: API keys + `/api/v1`, CSV import/export, payment links + public pay page, wallet passes, loyalty adjust/redeem, referrals, AI flags/voice/forecast, report schedule, segments | **26/26** |
| `fuzz.ts` | 343 malformed payloads across 49 mutation endpoints — must never 5xx | **0/343 5xx** |
| `super-admin.ts` | Platform console (17 read endpoints + actions). Needs a TOTP secret: `SA_MFA_SECRET=... bun run …` | **24/24** |
| `probe-lib.ts` | Shared helpers (cookie jar, CSRF header, `check`/`summary`) — not runnable on its own | — |

Every probe exits non-zero when a check fails, so they can gate CI.

## Notes

- Logins and seeded data come from `bun run seed` (hotels `grandpalace` /
  `seaview`, staff `staff@grandpalace.com` / `TestStaff123`).
- `route-sweep.ts` reads `GET /api/health` as a **readiness** probe: 200, or a
  503 that names the failing check (e.g. `worker: "stale"` when the background
  worker is not running — that is the endpoint working as designed).
- The probes create data (customers, orders, bills, passes…). Run them against
  a dev/test database, never production.
