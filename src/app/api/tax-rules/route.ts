import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

/**
 * Phase 14 — effective-dated GST tax rules (owner-only TAX_MANAGE).
 *
 * GET  /api/tax-rules — list (TAX_MANAGE or BILL_READ for the POS preview)
 * POST /api/tax-rules — create a rule
 *   { name, type: CGST_SGST|IGST|EXEMPT, rateBps, isInclusive,
 *     scopeType: ALL|CATEGORY|ITEM, scopeIds?, effectiveFrom, effectiveTo? }
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "BILL_READ");
    if (denied) return denied;

    const rules = await db.taxRule.findMany({
      where: { hotelId: auth.user.hotelId },
      orderBy: [{ active: "desc" }, { effectiveFrom: "desc" }],
    });
    return Response.json({ taxRules: rules });
  } catch (err) {
    return serverError(err);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "TAX_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 3) return jsonError("Rule name is required (min 3 chars).", 422, "INVALID_NAME");
    const type = body.type;
    if (type !== "CGST_SGST" && type !== "IGST" && type !== "EXEMPT") {
      return jsonError("type must be CGST_SGST, IGST or EXEMPT.", 422, "INVALID_TYPE");
    }
    const rateBps = Number(body.rateBps);
    if (!Number.isFinite(rateBps) || Math.floor(rateBps) !== rateBps || rateBps < 0 || rateBps > 10_000) {
      return jsonError("rateBps must be an integer between 0 and 10000 (0-100%).", 422, "INVALID_RATE");
    }
    if (type === "EXEMPT" && rateBps !== 0) {
      return jsonError("EXEMPT rules must have rateBps = 0.", 422, "INVALID_RATE");
    }
    const scopeType = body.scopeType;
    if (scopeType !== "ALL" && scopeType !== "CATEGORY" && scopeType !== "ITEM") {
      return jsonError("scopeType must be ALL, CATEGORY or ITEM.", 422, "INVALID_SCOPE");
    }
    if (scopeType !== "ALL") {
      if (!Array.isArray(body.scopeIds) || body.scopeIds.length === 0) {
        return jsonError("Scoped rules need a non-empty scopeIds array.", 422, "INVALID_SCOPE");
      }
      if (!(body.scopeIds as unknown[]).every((x) => typeof x === "string")) {
        return jsonError("scopeIds must be an array of strings.", 422, "INVALID_SCOPE");
      }
    }
    const effectiveFrom = typeof body.effectiveFrom === "string" ? new Date(body.effectiveFrom) : new Date();
    if (Number.isNaN(effectiveFrom.getTime())) {
      return jsonError("effectiveFrom must be an ISO date.", 422, "INVALID_DATE");
    }
    let effectiveTo: Date | null = null;
    if (typeof body.effectiveTo === "string" && body.effectiveTo) {
      effectiveTo = new Date(body.effectiveTo);
      if (Number.isNaN(effectiveTo.getTime())) {
        return jsonError("effectiveTo must be an ISO date.", 422, "INVALID_DATE");
      }
      if (effectiveTo <= effectiveFrom) {
        return jsonError("effectiveTo must be after effectiveFrom.", 422, "INVALID_DATE");
      }
    }

    const rule = await db.taxRule.create({
      data: {
        hotelId: auth.user.hotelId,
        name,
        type,
        rateBps: Math.floor(rateBps),
        isInclusive: body.isInclusive !== false,
        scopeType,
        scopeIds: scopeType === "ALL" ? null : JSON.stringify(body.scopeIds),
        effectiveFrom,
        effectiveTo,
      },
    });

    await logAudit({
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: "TAX_RULE_CREATED",
      entityType: "TaxRule",
      entityId: rule.id,
      metadata: { name, type, rateBps, isInclusive: rule.isInclusive, scopeType },
      req,
    });
    return Response.json({ taxRule: rule }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}
