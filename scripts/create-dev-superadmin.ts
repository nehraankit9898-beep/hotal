/**
 * Dev utility: create a Super Admin with a known password for local testing.
 * Usage: bun run scripts/create-dev-superadmin.ts
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth";

const db = new PrismaClient();

async function main() {
  const email = "super@stayloop.dev";
  const password = "SuperAdmin@123";
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    await db.user.update({
      where: { email },
      data: {
        passwordHash: hashPassword(password),
        mustChangePassword: false,
        status: "ACTIVE",
        emailVerified: new Date(),
      },
    });
    console.log("Super admin password reset:", email, "/", password);
  } else {
    await db.user.create({
      data: {
        name: "Platform Super Admin",
        email,
        passwordHash: hashPassword(password),
        role: "SUPER_ADMIN",
        status: "ACTIVE",
        emailVerified: new Date(),
        mustChangePassword: false,
      },
    });
    console.log("Super admin created:", email, "/", password);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
