/**
 * Endpoint redaction for logs.
 *
 * Only the origin + path prefix is kept; credentials embedded in the URL,
 * query strings and fragments are dropped. Nothing here ever touches the
 * API key — that lives in the Authorization header only.
 */
export function sanitizeEndpoint(raw: string | undefined | null): string {
  if (!raw) return "(none)";
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    // Not a URL (e.g. a bus/local placeholder). Keep only a harmless prefix.
    const fallback = raw.trim().split(/[?#]/)[0] ?? "";
    return fallback.slice(0, 80) || "(invalid)";
  }
  const path = url.pathname.replace(/\/+$/, "");
  const redacted = `${url.protocol}//${url.host}${path}`;
  return redacted.length > 120 ? `${redacted.slice(0, 117)}...` : redacted;
}
