import { db } from "@/lib/db";
import { requireAuth, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";

type Ctx = { params: Promise<{ id: string }> };

function escapeHtml(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtMinor(minor: number, currency: string): string {
  const symbol = currency === "INR" ? "₹" : `${currency} `;
  return `${symbol}${(minor / 100).toFixed(2)}`;
}

/**
 * GET /api/bills/[id]/receipt — print-friendly receipt (A6/80mm ready).
 * Returns HTML for window.print(); the bill snapshot is immutable.
 */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "BILL_READ");
    if (denied) return denied;

    const { id } = await ctx.params;
    const bill = await db.bill.findFirst({
      where: { id, hotelId: auth.user.hotelId },
      include: {
        table: { select: { number: true, zone: true } },
        lines: { orderBy: { id: "asc" } },
        payments: { orderBy: { paidAt: "asc" } },
        refunds: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!bill) return new Response("Not found", { status: 404 });

    let legal: Record<string, string> = {};
    try {
      legal = JSON.parse(bill.legalSnapshot ?? "{}");
    } catch {
      legal = {};
    }

    const rows = bill.lines
      .map(
        (l) => `<tr>
          <td>${escapeHtml(l.nameSnapshot)}</td>
          <td class="n">${l.quantity}</td>
          <td class="n">${fmtMinor(l.unitPriceMinor, bill.currency)}</td>
          <td class="n">${fmtMinor(l.lineTotalMinor, bill.currency)}</td>
        </tr>`,
      )
      .join("");

    const taxRows = bill.lines
      .flatMap((l) => {
        try {
          return JSON.parse(l.taxBreakup ?? "[]") as Array<{ name: string; amountMinor: number }>;
        } catch {
          return [];
        }
      })
      .reduce((acc, t) => {
        acc[t.name] = (acc[t.name] ?? 0) + t.amountMinor;
        return acc;
      }, {} as Record<string, number>);

    const taxHtml =
      Object.entries(taxRows)
        .map(([name, amt]) => `<tr class="muted"><td>${escapeHtml(name)}</td><td class="n">${fmtMinor(amt, bill.currency)}</td></tr>`)
        .join("") || "";

    const payRows = bill.payments
      .map(
        (p) =>
          `<tr><td>${escapeHtml(p.method)}${p.source === "MANUAL" ? " <span class='tag'>manually recorded</span>" : " <span class='tag ok'>gateway verified</span>"}</td><td class="n">${fmtMinor(p.amountMinor, bill.currency)}</td></tr>`,
      )
      .join("");

    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(bill.billNumber)}</title>
<style>
  body { font-family: ui-monospace, "Courier New", monospace; margin: 24px auto; max-width: 80mm; color: #111; }
  h1 { font-size: 15px; text-align: center; margin: 0 0 4px; }
  .muted { color: #555; font-size: 11px; }
  .n { text-align: right; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td, th { padding: 3px 4px; border-bottom: 1px dashed #bbb; text-align: left; }
  th { border-bottom: 1px solid #333; }
  .totals td { border: none; }
  .grand { font-weight: 700; font-size: 14px; border-top: 1px solid #333; }
  .tag { font-size: 9px; border: 1px solid #999; border-radius: 3px; padding: 0 3px; }
  .tag.ok { border-color: #0a7d33; color: #0a7d33; }
  @media print { body { margin: 0; } }
</style></head>
<body>
<h1>${escapeHtml(legal.hotelName ?? "")}</h1>
<div class="muted" style="text-align:center">
  ${escapeHtml(legal.address ?? "")}${legal.city ? `, ${escapeHtml(legal.city)}` : ""}<br/>
  ${legal.gstin ? `GSTIN: ${escapeHtml(legal.gstin)}` : ""}${legal.phone ? ` · ${escapeHtml(legal.phone)}` : ""}
</div>
<hr/>
<div class="muted">
  Invoice: <b>${escapeHtml(bill.billNumber)}</b><br/>
  Date: ${bill.issuedAt.toISOString().replace("T", " ").slice(0, 16)} UTC<br/>
  ${bill.table ? `Table: ${escapeHtml(bill.table.number)}<br/>` : ""}
  ${bill.customerName ? `Guest: ${escapeHtml(bill.customerName)}<br/>` : ""}
  Status: ${escapeHtml(bill.status)}
</div>
<table>
<thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<table class="totals">
<tr><td>Subtotal</td><td class="n">${fmtMinor(bill.subtotalMinor, bill.currency)}</td></tr>
${bill.discountMinor > 0 ? `<tr><td>Discount${bill.couponCode ? ` (${escapeHtml(bill.couponCode)})` : ""}</td><td class="n">− ${fmtMinor(bill.discountMinor, bill.currency)}</td></tr>` : ""}
${taxHtml ? `<tr><td>Tax (incl. in prices where applicable)</td><td class="n">${fmtMinor(bill.taxMinor, bill.currency)}</td></tr>` : ""}
<tr class="grand"><td>TOTAL</td><td class="n">${fmtMinor(bill.totalMinor, bill.currency)}</td></tr>
${payRows}
${bill.refundMinor > 0 ? `<tr><td>Refunded</td><td class="n">− ${fmtMinor(bill.refundMinor, bill.currency)}</td></tr>` : ""}
</table>
<p class="muted" style="text-align:center">Thank you for dining with us!</p>
<script>window.addEventListener("load", () => window.print());</script>
</body></html>`;

    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (err) {
    return serverError(err);
  }
}
