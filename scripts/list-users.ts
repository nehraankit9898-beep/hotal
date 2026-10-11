/** Dev helper — list users (email, role, hotel) for zip documentation. */
import { db } from "../src/lib/db";

async function main() {
  const users = await db.user.findMany({
    select: {
      email: true,
      role: true,
      mustChangePassword: true,
      hotel: { select: { name: true } },
    },
    orderBy: [{ role: "asc" }, { email: "asc" }],
  });
  for (const u of users) {
    console.log(
      `${u.role.padEnd(12)} | ${u.email.padEnd(32)} | ${u.hotel?.name ?? "-"} | mustChange=${u.mustChangePassword}`,
    );
  }
  const counts = {
    hotels: await db.hotel.count(),
    customers: await db.customer.count(),
    campaigns: await db.campaign.count(),
    loyaltyTxns: await db.loyaltyTransaction.count(),
    qrCodes: await db.qRCode.count(),
    feedback: await db.feedback.count(),
  };
  console.log("COUNTS:", JSON.stringify(counts));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
