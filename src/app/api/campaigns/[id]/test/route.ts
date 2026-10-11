import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { getProvider, providerStatus, type Channel } from "@/lib/providers";
import { personalize, sampleContext } from "@/lib/personalize";
import { parseChannels } from "@/lib/campaigns";
import { normalizePhone } from "@/lib/phone";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { testMessageSchema } from "@/lib/validation";
import { checkRateLimit } from "@/lib/rate-limit";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/campaigns/[id]/test — send a single test message.
 *
 * Hardened restore of the original feature (it was accidentally dropped during
 * the security refactor, leaving the builder UI's "Send test" button 404-ing):
 *  - RBAC: requires CAMPAIGN_SEND (same permission as a real send).
 *  - CSRF: enforced inside requireAuth() for cookie sessions.
 *  - Input: Zod-validated body {phone?, email?}; phone re-normalized.
 *  - Tenant scope: campaign must belong to the caller's hotel.
 *  - Rate limit: 10 test messages / 5 min / user (providers cost real money).
 *  - Audit: TEST_MESSAGE_SENT with provider + status (recipient masked —
 *    never stores full contact detail in metadata).
 *
 * The test goes to the phone/email the admin provides (usually their own),
 * with a SAMPLE personalization context so {{variables}} render with demo
 * values. Provider mode is reported honestly: if no real provider is
 * configured the message is sent through the Simulation provider and the
 * response clearly labels it as SIMULATION — we never claim a live delivery
 * that did not happen.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CAMPAIGN_SEND");
    if (denied) return denied;
    const { hotelId, userId, hotelName } = auth.user;
    const { id } = await ctx.params;

    // Per-user rate limit — test sends are free-form provider calls.
    const rl = await checkRateLimit(`campaign-test:${userId}`, 10, 5 * 60 * 1000);
    if (!rl.allowed) {
      return jsonError(
        `Too many test messages. Please wait ${rl.retryAfterSeconds}s and try again.`,
        429,
        "RATE_LIMITED",
      );
    }

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const parsed = testMessageSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(
        parsed.error.issues[0]?.message ??
          "Enter a phone number (or email) to send the test message to.",
      );
    }
    const rawPhone = parsed.data.phone ?? "";
    const rawEmail = parsed.data.email ?? "";

    const phoneResult = rawPhone ? normalizePhone(rawPhone) : null;
    if (rawPhone && (!phoneResult || !phoneResult.ok || !phoneResult.normalized)) {
      return jsonError(
        phoneResult?.error ?? "That phone number does not look valid. Please check and try again.",
      );
    }
    const phone = phoneResult?.normalized ?? null;

    // Tenant-scoped campaign lookup — never leak another hotel's campaign.
    const campaign = await db.campaign.findFirst({ where: { id, hotelId } });
    if (!campaign) return jsonError("Campaign not found in your hotel.", 404, "NOT_FOUND");

    const channels = parseChannels(campaign.channels);
    if (channels.length === 0) {
      return jsonError("This campaign has no messaging channel selected.");
    }
    const channel: Channel = channels[0];

    const preview = personalize(campaign.messageTemplate, sampleContext(hotelName, campaign.offer));

    const recipient = channel === "EMAIL" ? rawEmail : (phone as string);
    if (!recipient) {
      return jsonError(
        channel === "EMAIL"
          ? "Enter an email address for the email test message."
          : "Enter a phone number for the test message.",
      );
    }
    if (channel === "EMAIL" && !recipient.includes("@")) {
      return jsonError("Enter a valid email address for the email test message.");
    }

    const provider = getProvider(channel);
    const result = await provider.send({ to: recipient, body: preview });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.TEST_MESSAGE_SENT,
      entityType: "campaign",
      entityId: campaign.id,
      metadata: {
        channel,
        recipientMasked:
          channel === "EMAIL"
            ? recipient.replace(/^(.).*(@.*)$/, "$1***$2")
            : `***${recipient.slice(-3)}`,
        provider: result.provider,
        status: result.ok ? "SENT" : "FAILED",
      },
    });

    if (!result.ok) {
      return jsonError(
        `Test message could not be sent: ${result.error ?? "provider error"}. Check your provider settings.`,
        502,
        "TEST_FAILED",
      );
    }

    return Response.json({
      preview,
      message:
        providerStatus().mode === "SIMULATION"
          ? `Test message sent via the SIMULATION provider to ${recipient}. Configure WhatsApp/SMS credentials to send live messages.`
          : `Test message sent via ${result.provider} to ${recipient}.`,
      channel,
      recipient,
      provider: result.provider,
      providerMode: providerStatus().mode,
      providerMessageId: result.providerMessageId ?? null,
    });
  } catch (err) {
    return serverError(err, "The test message could not be sent. Please try again.");
  }
}
