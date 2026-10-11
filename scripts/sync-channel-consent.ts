/**
 * Phase 6.4 dev-data sync — backfills channel opt-ins for consented
 * customers (mirrors the updated seed: consented guests opted into
 * WhatsApp + SMS, email where an address exists).
 * Usage: bun run scripts/sync-channel-consent.ts
 */
import { db } from "../src/lib/db";

async function main() {
  const consented = await db.customer.findMany({
    where: { marketingConsent: true, optOut: false },
    select: { id: true, email: true },
  });
  let updated = 0;
  for (const c of consented) {
    await db.customer.update({
      where: { id: c.id },
      data: {
        whatsappOptIn: true,
        smsOptIn: true,
        emailOptIn: Boolean(c.email),
      },
    });
    updated++;
  }
  console.log(`✅ Channel opt-ins backfilled for ${updated} consented customer(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
