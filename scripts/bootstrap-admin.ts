/**
 * One-time Super Admin bootstrap (Phase 2).
 *
 * Usage:
 *   ADMIN_BOOTSTRAP_SECRET=<secret> bun run scripts/bootstrap-admin.ts --name "Platform Admin" --email admin@example.com
 *
 * Behavior:
 *   - Refuses to run unless ADMIN_BOOTSTRAP_SECRET is set (and matches none —
 *     the script runs server-side, so possessing the env secret IS the auth).
 *   - Refuses to run when a Super Admin already exists.
 *   - Generates a cryptographically random temporary password, prints it ONCE,
 *     and marks the account mustChangePassword. The platform is unusable until
 *     the password is changed. No password is ever written to logs.
 */
import { PrismaClient } from "@prisma/client";
import { bootstrapFirstSuperAdmin } from "../src/lib/super-admin";
import { randomBytes } from "crypto";

const db = new PrismaClient();

function arg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

async function main() {
  const secret = process.env.ADMIN_BOOTSTRAP_SECRET;
  if (!secret || secret.trim() === "") {
    console.error("ADMIN_BOOTSTRAP_SECRET is not set — bootstrap disabled (fail-closed).");
    process.exit(1);
  }
  const name = arg("--name") ?? "Platform Super Admin";
  const email = (arg("--email") ?? "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Usage: --name "..." --email you@example.com');
    process.exit(1);
  }

  try {
    const result = await bootstrapFirstSuperAdmin({ name, email, bootstrapSecret: secret });
    console.log("Super Admin created.");
    console.log(`  Email:             ${result.email}`);
    console.log(`  Temporary password: ${result.temporaryPassword}`);
    console.log("");
    console.log("Share this temporary password over a SECURE channel, then sign in and change it.");
    console.log("It is shown only once and is not stored in plaintext or logs.");
    console.log("The account cannot use the platform until the password is changed.");
  } catch (err) {
    console.error("Bootstrap failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await db.$disconnect();
  }
  void randomBytes;
}

main();
