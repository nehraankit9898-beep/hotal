import { isTest } from "@/lib/config";
import { getMockOutbox } from "@/lib/providers/email";

/**
 * TEST-ONLY — GET /api/test/mock-emails
 * Exposes the captured mock email outbox so the automated suite (tests/) can
 * assert on transactional emails. Guarded by STAYLOOP_TEST/NODE_ENV=test:
 * in any other environment the endpoint does not exist (404 by design).
 */
export async function GET() {
  if (!isTest()) {
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found." } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const emails = getMockOutbox().map((e) => ({
    to: e.to,
    subject: e.subject,
    kind: e.kind,
    html: e.html,
    text: e.text,
    ts: e.ts,
    provider: e.provider,
  }));
  return Response.json({ ok: true, emails });
}
