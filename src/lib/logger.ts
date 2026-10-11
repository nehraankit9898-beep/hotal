/**
 * Phase 7 — structured logging with secret redaction.
 *
 * - JSON-lines output (one object per line) so any log pipeline can parse it.
 * - Every entry carries: ts, level, event, and optional requestId correlation.
 * - Keys that look sensitive are redacted BEFORE serialization (defense in
 *   depth — callers must also avoid passing secrets, this is the safety net).
 * - Never logs: passwords, tokens, session secrets, API keys, encryption keys.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): Level {
  const raw = (
    process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug")
  ).toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

/** Keys whose values must never reach the log stream. */
const SENSITIVE_KEY_RE =
  /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential|encryption|salt|hash|bearer|session/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Heuristic: never serialize anything that looks like an embedded credential.
    if (/^(Bearer|Basic)\s+/i.test(value)) return "[redacted]";
    if (value.startsWith("scrypt$") || value.startsWith("sha256$")) return "[redacted]";
    return value.length > 2000 ? value.slice(0, 2000) + "…[truncated]" : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function write(level: Level, event: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
  };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      entry[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redact(v);
    }
  }
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => write("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => write("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write("error", event, fields),
};

export type Logger = typeof logger;
