export function localWebURL(origin: string, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error("Koinote web path must be an absolute local path");
  }
  const base = new URL(origin);
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new Error("Koinote web origin must use HTTP or HTTPS");
  }
  const url = new URL(path, `${base.origin}/`);
  if (url.origin !== base.origin) {
    throw new Error("Koinote web path must stay on the configured origin");
  }
  return url.toString();
}
