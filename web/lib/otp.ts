import { SignJWT, jwtVerify } from "jose";
import { createHash, randomInt } from "crypto";
import { AUTH_SECRET, PENDING_TTL_S } from "./config";

const enc = new TextEncoder();

export function generateCode(): string {
  return String(randomInt(0, 1e8)).padStart(8, "0");
}

export function hashCode(code: string, email: string): string {
  return createHash("sha256").update(`${email}:${code}:${AUTH_SECRET()}`).digest("hex");
}

export async function signPending(email: string, code: string): Promise<string> {
  const codeHash = hashCode(code, email);
  return await new SignJWT({ email, codeHash, attempts: 0 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${PENDING_TTL_S}s`)
    .setIssuer("conduit")
    .setAudience("pending")
    .sign(enc.encode(AUTH_SECRET()));
}

export async function verifyPending(
  token: string,
  email: string,
  code: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const { payload } = await jwtVerify(token, enc.encode(AUTH_SECRET()), {
      issuer: "conduit",
      audience: "pending",
    });
    if (String(payload.email).toLowerCase() !== email.toLowerCase()) {
      return { ok: false, reason: "Mail stimmt nicht mit Code-Anfrage überein." };
    }
    if (payload.codeHash !== hashCode(code, email)) {
      return { ok: false, reason: "Code falsch." };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "Code abgelaufen — bitte neuen anfordern." };
  }
}
