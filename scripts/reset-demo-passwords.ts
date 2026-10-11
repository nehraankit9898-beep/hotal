/**
 * Dev helper — reset the demo accounts to known passwords.
 * Usage: STAYLOOP_DEMO_PASSWORD="DevAdmin123" bun run scripts/reset-demo-passwords.ts
 * (Local development only; never run in production.)
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";

async function main() {
  const pw = process.env.STAYLOOP_DEMO_PASSWORD || "DevAdmin123";
  if (pw.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }
  const hash = hashPassword(pw);
  const res = await db.user.updateMany({
    where: { email: { in: ["admin@grandpalace.com", "admin@seaview.com"] } },
    data: {
      passwordHash: hash,
      mustChangePassword: false,
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });
  await db.user.updateMany({
    where: { email: "staff@grandpalace.com" },
    data: {
      passwordHash: hashPassword("DevStaff123"),
      mustChangePassword: false,
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });
  await db.user.updateMany({
    where: { email: "superadmin@stayloop.io" },
    data: {
      passwordHash: hashPassword("DevSuper123"),
      mustChangePassword: false,
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });
  console.log(
    `✅ Reset ${res.count} admin password(s) to the STAYLOOP_DEMO_PASSWORD, staff to DevStaff123, super admin to DevSuper123.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
