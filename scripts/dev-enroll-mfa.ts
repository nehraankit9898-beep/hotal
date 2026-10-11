/**
 * Dev utility: enroll TOTP MFA for the dev super admin using lib functions.
 * Usage: bun run scripts/dev-enroll-mfa.ts
 */
import { PrismaClient } from "@prisma/client";
import { beginMfaSetup, confirmMfaSetup } from "../src/lib/mfa";

const db = new PrismaClient();

async function main() {
  const user = await db.user.findUnique({ where: { email: "super@stayloop.dev" } });
  if (!user) throw new Error("super@stayloop.dev not found");

  if (!user.mfaEnabled) {
    await beginMfaSetup(user.id);
    // confirm needs a live code — generate from stored secret after begin
    const updated = await db.user.findUnique({
      where: { id: user.id },
      select: { mfaSecret: true },
    });
    const { decryptTotpForDev } = { decryptTotpForDev: null } as any;
    // confirmMfaSetup verifies a live TOTP; we can compute it via the setup secret we just stored
    const { generateTotp } = await import("../src/lib/mfa");
    const { decryptSecret } = await import("../src/lib/mfa").catch(() => ({
      decryptSecret: null as any,
    }));
    // decryptSecret is not exported; instead re-derive: begin stores encryptSecret(secret)
    // Easiest: call confirmMfaSetup with a code generated from the *known* plaintext we can't read back…
    // Workaround: temporarily flip mfaEnabled=false and use verify path? Simpler: brute check window using code from a fresh beginMfaSetup return value.
    const setup = await beginMfaSetup(user.id); // returns plaintext secret
    const code = generateTotp(setup.secret);
    const result = await confirmMfaSetup(user.id, code);
    if (!result.ok) throw new Error("MFA confirm failed: " + result.error);
    await Bun.write("/home/z/my-project/.dev-mfa-secret", setup.secret);
    console.log("MFA enrolled. Secret saved to .dev-mfa-secret");
  } else {
    console.log("MFA already enabled for", user.email);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
