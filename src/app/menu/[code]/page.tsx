import { PublicMenuRoot } from "@/components/public/menu-root";

/**
 * Phase 12/13 — public QR menu + ordering page.
 * /menu/[code] — the mobile page a diner lands on after scanning a table QR.
 * Fully public (no auth): the unpredictable code is the capability. Table-bound
 * ORDER QR codes enable cart + ordering; plain MENU codes are browse-only.
 */
export default async function PublicMenuPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <PublicMenuRoot code={code} />;
}
