/**
 * GET /api/v1 — self-describing index for the developer API.
 * (The catch-all [...path] route only matches paths WITH at least one segment,
 * so the bare /api/v1 index lives here.)
 */
import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-keys";

export async function GET(req: Request) {
  const authResult = await authenticateApiKey(req);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: { code: authResult.code, message: authResult.message } },
      { status: authResult.status },
    );
  }
  return NextResponse.json({
    data: {
      name: "RestroLoop Developer API",
      version: "v1",
      hotel: authResult.auth.hotelName,
      scopes: authResult.auth.scopes,
      endpoints: [
        {
          method: "GET",
          path: "/api/v1/customers",
          description: "List customers (q, page, pageSize)",
        },
        {
          method: "POST",
          path: "/api/v1/customers",
          description: "Create a customer (name, phone)",
        },
        { method: "GET", path: "/api/v1/customers/{id}", description: "Get one customer" },
        {
          method: "GET",
          path: "/api/v1/visits",
          description: "List visits (phone, page, pageSize)",
        },
        { method: "POST", path: "/api/v1/visits", description: "Record a visit (phone, checkin)" },
        {
          method: "GET",
          path: "/api/v1/loyalty?phone=",
          description: "Loyalty balance for a phone",
        },
        { method: "GET", path: "/api/v1/stats", description: "Basic hotel totals" },
      ],
    },
  });
}
