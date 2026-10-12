/**
 * Request-body helpers (pure — no database import, so they are unit-testable).
 */

/** Max accepted JSON body size for API routes. */
export const MAX_JSON_BODY_BYTES = 1024 * 1024; // 1 MB

/**
 * Read the request body as text, enforcing MAX_JSON_BODY_BYTES on the bytes actually
 * received. AUDIT FIX (SEC-005): the previous check trusted the Content-Length header
 * only, so a chunked / length-less body was buffered without limit.
 */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Parse + validate JSON body safely (size-capped, object-shaped). */
export async function readJsonCapped(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await readBodyCapped(req, MAX_JSON_BODY_BYTES);
    if (text === null) return null;
    const body = JSON.parse(text);
    if (typeof body !== "object" || body === null) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}
