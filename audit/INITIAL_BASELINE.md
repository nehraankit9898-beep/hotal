# Initial Baseline — StayLoop (2026-10-11)

Recorded before any change. Commands and exit codes are from this sandbox (see `TEST_RESULTS.md` for environment).

| Check | Command | Result |
|---|---|---|
| Git branch | `git branch --show-current` | `arena/4731a2f4-hotal` |
| Working tree | `git status --short` | clean |
| HEAD | `git log --oneline -1` | `b398b81 Merge pull request #1 …` |
| Install | `bun install --frozen-lockfile` | exit 0 · 561 packages |
| Typecheck | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Secret scan | `bun run scan:secrets` | exit 0 · clean |
| Production dependency audit | `npm audit --omit=dev --audit-level=high` | exit 0 · 0 vulnerabilities |
| Production build | `bun run build` | exit 1 · blocked (Google Fonts not reachable) |
| Full test suite | `bun run test` | exit 1 · seed step failed (Prisma engine missing); no suite ran |
| Per-file tests | `bun test tests/<file>` for 31 files | 2 files fully pass, 3 partially, the rest blocked (see `REMAINING_RISKS.md` §5) |

## Environment limits found at baseline
- Bun was not installed. Installed from npm as `bun@1.3.14`. This matches the CI pin.
- The Prisma engines could not be downloaded from `binaries.prisma.sh` (not on the host allow-list).
  The client was generated with placeholder engine paths. Runtime database access is therefore impossible here.
- No Docker, Redis, PostgreSQL, or browser.

## Repository facts at baseline
- No `package-lock.json` is committed; the project uses `bun.lock` (CI runs `bun install --frozen-lockfile`).
- `.gitignore` excludes `.env*` (except examples), `.auth-secret.dev`, `db/*.db`, `.next/`, `*.log`.
- `scripts/scan-secrets.ts` covers tracked files only. Untracked files should be scanned before commit.
