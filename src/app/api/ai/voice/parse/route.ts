import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { loadVoiceCatalog, parseVoiceTranscript } from "@/lib/ai/voice";
import { getAISettings, logAIInteraction } from "@/lib/ai/governance";

/**
 * Phase 18 — voice cart parsing (AI_READ is enough: it is an ordering aid,
 * not a governance action; any staff role that can create orders can use it).
 *
 * POST /api/ai/voice/parse { transcript } — parse a Web Speech transcript
 * into a cart PROPOSAL. The response is needsConfirmation:true ALWAYS — the
 * client must render the proposal and get an explicit human confirmation
 * before any submit. No audio is ever sent here (text transcript only).
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    // Staff voice use sits with order-creation capability.
    const denied = requirePermission(auth.user, "ORDER_CREATE");
    if (denied) return denied;

    const settings = await getAISettings(auth.user.hotelId);
    if (!settings.voiceEnabled) {
      return jsonError("Voice ordering is disabled for this tenant.", 403, "VOICE_DISABLED");
    }

    const body = (await readJson(req)) ?? {};
    const transcript = typeof body.transcript === "string" ? body.transcript : "";
    if (!transcript.trim()) return jsonError("transcript is required.", 422, "MISSING_TRANSCRIPT");
    if (transcript.length > 500) return jsonError("transcript too long (max 500 chars).", 422, "TRANSCRIPT_TOO_LONG");

    const catalog = await loadVoiceCatalog(auth.user.hotelId);
    const result = parseVoiceTranscript(transcript, catalog);

    await logAIInteraction({
      hotelId: auth.user.hotelId, kind: "VOICE", subtype: "PARSE",
      status: result.lines.length ? "OK" : "REFUSED",
      reason: result.lines.length ? null : "NO_ITEMS_RECOGNIZED",
      channel: "VOICE",
      meta: { recognized: result.lines.length, unrecognized: result.unrecognized.length },
    });

    return Response.json({ ...result });
  } catch (err) {
    return serverError(err);
  }
}
