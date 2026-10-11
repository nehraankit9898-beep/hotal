import { requireAuth, jsonOk, serverError } from "@/lib/api-helpers";
import { generateCsrfToken, CSRF_COOKIE, csrfCookieOptions } from "@/lib/csrf";

/** GET /api/auth/me — current user; also bootstraps the CSRF cookie if missing. */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const { user } = auth;

    const res = jsonOk({ user });

    // Ensure a CSRF cookie exists for the double-submit check. The JS client
    // sends this value back in the x-csrf-token header on mutations.
    const cookieHeader = req.headers.get("cookie") ?? "";
    const hasCsrf = cookieHeader.split(";").some((c) => c.trim().startsWith(`${CSRF_COOKIE}=`));
    if (!hasCsrf) {
      res.cookies.set(CSRF_COOKIE, generateCsrfToken(), csrfCookieOptions(req));
    }
    return res;
  } catch (err) {
    return serverError(err);
  }
}
