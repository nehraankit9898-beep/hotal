/**
 * Phase 7 — secret scanner (spec §3 "Detect accidental secrets during CI").
 *
 * Scans tracked source files for:
 * - known placeholder dev secrets shipped with earlier phases
 * - high-entropy strings that look like API keys / tokens / private keys
 * - .env files accidentally added to the working tree
 *
 * Usage: bun run scripts/scan-secrets.ts   (exit 1 = findings, 0 = clean)
 * CI:    runs on every push (see .github/workflows/ci.yml).
 *
 * Tuning: allowlists live in ALLOWED_PATTERNS below (e.g. the test-only
 * secret values in .env.test.example and test fixtures, which are safe by
 * design and clearly labeled).
 */

import { execSync } from "child_process";
import fs from "fs";

interface Finding {
  file: string;
  line: number;
  rule: string;
  preview: string;
}

const ALLOWED_PATTERNS: { rule: string; re: RegExp }[] = [
  // Test-only secrets (clearly labeled, derived/ignored in production paths)
  { rule: "test-fixture", re: /test_only_[a-z_0-9]+/i },
  { rule: "test-fixture", re: /dev_auth_secret_key_at_least_32_chars_long_x9/ },
  { rule: "example-doc", re: /CHANGE_ME|your[_-]?api[_-]?key|no-reply@/i },
  // Placeholder names in env templates (empty values)
  { rule: "empty-env", re: /^[A-Z_]+=\s*$/ },
  // src/lib/config.ts FORBIDDEN_SECRET_VALUES blocklist — previously-shipped
  // dev secret VALUES listed as rejected strings (defense, not exposure).
  {
    rule: "blocklist-entry",
    re: /^\s*"(phase2-webhook-secret-2026|stayloop_dev_webhook_secret_2026)",\s*$/,
  },
  // docs/SECRET_ROTATION.md lists the legacy compromised VALUES by name so
  // operators can grep for them — intentional documentation, not exposure.
  {
    rule: "rotation-doc-entry",
    re: /^\s*[-*]\s*`(phase2-webhook-secret-2026|stayloop_dev_webhook_secret_2026)`/,
  },
  // The scanner's own rule definitions are regexes over those names.
  {
    rule: "scanner-self",
    re: /rule:\s*"(legacy-phase2-webhook-secret|legacy-dev-auth-secret)"|blocklist-entry|rotation-doc-entry/,
  },
  // env.ts PLACEHOLDER_VALUES contains fake all-x sample keys that are
  // REJECTED at startup — blocklist literals, not real secrets.
  { rule: "placeholder-blocklist", re: /^\s*"[^"]*[xX]{10,}[^"]*",\s*$/ },
];

const SECRET_RULES: { rule: string; re: RegExp }[] = [
  { rule: "legacy-dev-auth-secret", re: /stayloop_dev_[a-z0-9_]*secret[a-z0-9_]*/i },
  {
    rule: "legacy-phase2-webhook-secret",
    re: /phase2-webhook-secret-2026|stayloop_dev_webhook_secret_2026/,
  },
  { rule: "private-key-block", re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { rule: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "resend-api-key", re: /\bre_[A-Za-z0-9]{32,45}\b/ },
  { rule: "sendgrid-api-key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { rule: "twilio-api-key", re: /\bSK[0-9a-fA-F]{32}\b/ },
  { rule: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { rule: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    rule: "jwt-hardcoded",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    rule: "assigned-hex-secret",
    re: /(?:secret|token|apikey|api_key|password|passwd)\s*[:=]\s*["']([0-9a-f]{40,}|[A-Za-z0-9+/]{43}={0,2})["']/i,
  },
];

// Files that must never ship regardless of content.
const FORBIDDEN_FILES = [
  /^\.env$/,
  /^\.env\.(local|dev|prod|production)$/,
  /\.pem$/,
  /\.p12$/,
  /\.key$/,
];

function isAllowed(line: string): boolean {
  return ALLOWED_PATTERNS.some((a) => a.re.test(line));
}

function listFiles(): string[] {
  let out: string;
  try {
    out = execSync("git ls-files", { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  } catch {
    // Not a git repo — walk the tree crudely instead.
    out = execSync(`find src prisma scripts docs tests .github -type f 2>/dev/null || true`, {
      encoding: "utf8",
      shell: "/bin/bash",
    });
  }
  const files = out.split("\n").filter(Boolean);
  // Add env TEMPLATES explicitly (never the real .env — a local untracked
  // .env is expected for dev; it must simply never be git-tracked).
  files.push(".env.example", ".env.production.example", ".env.test.example");
  const uniq = [...new Set(files)];
  // Defense in depth: if a real .env IS git-tracked, flag it.
  try {
    const tracked = execSync("git ls-files .env .env.local .env.dev .env.production", {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    for (const t of tracked) if (!uniq.includes(t)) uniq.push(t);
  } catch {
    /* not a git repo */
  }
  return uniq;
}

const findings: Finding[] = [];

for (const file of listFiles()) {
  // Real env files are flagged ONLY when git-tracked (see listFiles).
  if (FORBIDDEN_FILES.some((re) => re.test(file))) {
    findings.push({
      file,
      line: 0,
      rule: "forbidden-file-tracked",
      preview: "(env/secret file is tracked in git)",
    });
    continue;
  }
  // Binary-ish / lockfiles: skip content scan (huge, no secrets of ours).
  if (
    /\.(png|jpg|jpeg|gif|ico|woff2?|ttf|zip|db)$/i.test(file) ||
    /bun\.lock|package-lock/.test(file)
  )
    continue;
  // The scanner's own source only contains its regex rules — skip self-scan.
  if (file === "scripts/scan-secrets.ts") continue;
  if (!fs.existsSync(file)) continue;

  const content = fs.readFileSync(file, "utf8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isAllowed(line)) continue;
    for (const { rule, re } of SECRET_RULES) {
      if (re.test(line)) {
        findings.push({
          file,
          line: i + 1,
          rule,
          preview: line.trim().slice(0, 60) + (line.trim().length > 60 ? "…" : ""),
        });
      }
    }
  }
}

if (findings.length > 0) {
  console.error(`SECRET SCAN — ${findings.length} finding(s):\n`);
  for (const f of findings) {
    console.error(`  [${f.rule}] ${f.file}:${f.line}`);
    console.error(`    ${f.preview}\n`);
  }
  console.error(
    "Remove the secret, move it to environment configuration, and rotate it if it was ever committed.",
  );
  process.exit(1);
} else {
  console.log("SECRET SCAN — clean (no secrets detected in tracked files).");
  process.exit(0);
}
