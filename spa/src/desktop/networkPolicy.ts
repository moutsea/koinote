export function shouldAttachDesktopAuthorization(
  path: string,
  apiOrigin: string,
): boolean {
  try {
    const normalizedOrigin = new URL(apiOrigin).origin;
    return new URL(path, `${normalizedOrigin}/`).origin === normalizedOrigin;
  } catch {
    return false;
  }
}

export function isDesktopAuthenticationRejection(status: number): boolean {
  return status === 401 || status === 403;
}
