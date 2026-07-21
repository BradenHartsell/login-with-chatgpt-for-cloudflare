export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

export type CookieSameSite = "Strict" | "Lax" | "None";

export function sessionCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
  sameSite: CookieSameSite,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
    "HttpOnly",
    `SameSite=${sameSite}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(name: string, secure: boolean, sameSite: CookieSameSite): string {
  return sessionCookie(name, "", 0, secure, sameSite);
}
