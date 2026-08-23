export function feedbackPagePath(pathname: string): string {
  return pathname.startsWith("/share/") ? "/share/:token" : pathname;
}
