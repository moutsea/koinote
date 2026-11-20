/** Origin credentials are only added to requests sent to our own Go backend. */
export function backendHeaders(
  env: { BACKEND_ORIGIN_TOKEN?: string },
  initial?: HeadersInit,
): Headers {
  const headers = new Headers(initial);
  // Never forward a caller-supplied origin credential, including in local mode.
  headers.delete("x-koinote-origin-token");
  if (env.BACKEND_ORIGIN_TOKEN) {
    headers.set("x-koinote-origin-token", env.BACKEND_ORIGIN_TOKEN);
  }
  return headers;
}
