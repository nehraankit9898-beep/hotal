/**
 * Next.js instrumentation hook — runs once when the server boots.
 * Phase 1: fail-closed startup validation. A production deployment with a
 * missing or weak AUTH_SECRET / INTEGRATION_ENCRYPTION_KEY refuses to start.
 * Phase 7: additionally validates the full extended environment (env.ts) and
 * validates the optional variable set (Redis URL, email provider config, etc.).
 */
export async function register() {
  // Only run in the Node.js server runtime (not edge).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { validateStartupConfig } = await import("@/lib/config");
  const result = validateStartupConfig();

  const { validateExtendedEnv } = await import("@/lib/env");
  const extended = validateExtendedEnv();

  const errors = [...result.errors, ...extended.errors];
  if (errors.length > 0) {
    // Throwing here crashes startup in production — by design (fail closed).
    throw new Error(
      "StayLoop configuration is invalid:\n" + errors.map((e) => `  - ${e}`).join("\n"),
    );
  }

  if (extended.warnings.length > 0 && process.env.NODE_ENV === "production") {
    const { logger } = await import("@/lib/logger");
    for (const w of extended.warnings) logger.warn("config.warning", { message: w });
  }
}
