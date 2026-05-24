import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { AUTH_SECRET, BRIDGE_SECRET, SESSION_COOKIE, SESSION_TTL_S } from "./config";

function secret(s: string) {
  return new TextEncoder().encode(s);
}

export async function signSession(email: string): Promise<string> {
  return await new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_S}s`)
    .setIssuer("conduit")
    .setAudience("web")
    .sign(secret(AUTH_SECRET()));
}

export async function verifySession(token: string): Promise<{ email: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret(AUTH_SECRET()), {
      issuer: "conduit",
      audience: "web",
    });
    return { email: String(payload.email) };
  } catch {
    return null;
  }
}

export async function getSessionFromCookies(): Promise<{ email: string } | null> {
  const c = await cookies();
  const token = c.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}

export async function signBridgeToken(email: string, sessionId: string): Promise<string> {
  return await new SignJWT({ email, sid: sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setIssuer("conduit")
    .setAudience("bridge")
    .sign(secret(BRIDGE_SECRET()));
}

export async function signApiToken(email: string): Promise<string> {
  return await new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2m")
    .setIssuer("conduit")
    .setAudience("api")
    .sign(secret(BRIDGE_SECRET()));
}
