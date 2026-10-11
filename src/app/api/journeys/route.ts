import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";

/** GET /api/journeys — list journeys for the hotel */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CAMPAIGN_READ");
    if (denied) return denied;

    const journeys = await db.journey.findMany({
      where: { hotelId: auth.user.hotelId },
      orderBy: { createdAt: "desc" },
      include: { steps: { orderBy: { sortOrder: "asc" } } },
    });

    return Response.json({ journeys });
  } catch (err) {
    return serverError(err, "Journeys could not be loaded.");
  }
}

/** POST /api/journey — create a journey with default steps */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CAMPAIGN_CREATE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request.");

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 3) return jsonError("Please enter a journey name (at least 3 characters).");

    const steps = Array.isArray(body.steps) ? (body.steps as Record<string, unknown>[]) : [];
    if (steps.length === 0) return jsonError("A journey must have at least one step.");
    if (steps.length > 12) return jsonError("A journey can have at most 12 steps.");

    // Medium fix (item 6): validate steps BEFORE persisting. The old code
    // accepted negative offsetDays, unvalidated channels, and CROSS-TENANT
    // couponIds (a journey could attach another hotel's coupon to messages).
    const VALID_CHANNELS = ["WHATSAPP", "SMS", "EMAIL"];
    const cleanedSteps: {
      offsetDays: number;
      label: string;
      messageTemplate: string;
      channels: string;
      offer: string | null;
      couponId: string | null;
      sortOrder: number;
      enabled: boolean;
    }[] = [];
    for (let idx = 0; idx < steps.length; idx++) {
      const s = steps[idx];
      const offsetDays = Number(s.offsetDays ?? 0);
      if (!Number.isInteger(offsetDays) || offsetDays < 0 || offsetDays > 365) {
        return jsonError(`Step ${idx + 1}: offsetDays must be an integer 0-365.`);
      }
      const template = String(s.messageTemplate ?? "").trim();
      if (template.length < 1 || template.length > 2000) {
        return jsonError(`Step ${idx + 1}: messageTemplate is required (1-2000 characters).`);
      }
      const channelsRaw = Array.isArray(s.channels) ? s.channels : ["WHATSAPP"];
      const channels = channelsRaw.filter(
        (c): c is string => typeof c === "string" && VALID_CHANNELS.includes(c),
      );
      if (channels.length === 0) {
        return jsonError(`Step ${idx + 1}: channels must include WHATSAPP, SMS and/or EMAIL.`);
      }
      const couponId = typeof s.couponId === "string" && s.couponId ? s.couponId : null;
      if (couponId) {
        const coupon = await db.coupon.findFirst({
          where: { id: couponId, hotelId: auth.user.hotelId },
          select: { id: true },
        });
        if (!coupon) {
          return jsonError(`Step ${idx + 1}: coupon not found in your hotel.`);
        }
      }
      cleanedSteps.push({
        offsetDays,
        label: String(s.label ?? `Day ${offsetDays}`).slice(0, 120),
        messageTemplate: template,
        channels: JSON.stringify(channels),
        offer: typeof s.offer === "string" ? s.offer.slice(0, 500) : null,
        couponId,
        sortOrder: idx,
        enabled: s.enabled !== false,
      });
    }

    const journey = await db.journey.create({
      data: {
        hotelId: auth.user.hotelId,
        name,
        description: typeof body.description === "string" ? body.description || null : null,
        enabled: body.enabled !== false,
        steps: {
          create: cleanedSteps,
        },
      },
      include: { steps: true },
    });

    return Response.json({ journey }, { status: 201 });
  } catch (err) {
    return serverError(err, "Journey could not be created.");
  }
}
