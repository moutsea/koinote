// Shared by password/OAuth login and the desktop authorization callback.
export function loginRedirectPath(search: string, fallback = "/settings") {
  const candidate = new URLSearchParams(search).get("redirectTo")?.trim() ?? "";
  return candidate.startsWith("/") &&
    !candidate.startsWith("//") &&
    !/[\\\u0000-\u001f\u007f]/.test(candidate)
    ? candidate
    : fallback;
}
