// Shared URL-scheme safety helper.
//
// Pasted/imported event URLs are untrusted. Only http(s) URLs may ever become
// a live href. Everything else (javascript:, data:, vbscript:, mailto weirdness,
// or a malformed URL) is rejected so it cannot execute or exfiltrate on click.
//
// Two shapes:
//   • safeHref(url)  → the url string when its scheme ∈ {http,https}, else null.
//                      Callers render a clickable link ONLY when this is non-null.
//   • normalizeUrl(url) → the url when safe, else "" — used server-side so the
//                      /api/rank RESPONSE never carries a dangerous scheme.

export function safeHref(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  return scheme === "http" || scheme === "https" ? trimmed : null;
}

/** Server-side normalization: safe url string, or "" when unsafe/malformed. */
export function normalizeUrl(url: unknown): string {
  if (typeof url !== "string") return "";
  return safeHref(url) ?? "";
}
