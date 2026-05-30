import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { AUTH_SECRET } from "./config";

const enc = new TextEncoder();

type Limiter = {
  cookie: string;
  audience: string;
  windowMs: number;
  maxHits: number;
  ttlS: number;
};

// Request a login code: 5 / 10 min.
const REQUEST_LIMITER: Limiter = {
  cookie: "conduit_rl",
  audience: "rl",
  windowMs: 10 * 60 * 1000,
  maxHits: 5,
  ttlS: 30 * 60,
};

// Verify a code: 8 / 10 min — caps brute-force against the stateless pending JWT.
const VERIFY_LIMITER: Limiter = {
  cookie: "conduit_rl_verify",
  audience: "rl-verify",
  windowMs: 10 * 60 * 1000,
  maxHits: 8,
  ttlS: 30 * 60,
};

async function read(l: Limiter): Promise<number[]> {
  const c = await cookies();
  const tok = c.get(l.cookie)?.value;
  if (!tok) return [];
  try {
    const { payload } = await jwtVerify(tok, enc.encode(AUTH_SECRET()), { issuer: "conduit", audience: l.audience });
    return Array.isArray(payload.hits) ? (payload.hits as number[]) : [];
  } catch { return []; }
}

async function write(l: Limiter, hits: number[]) {
  const tok = await new SignJWT({ hits })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${l.ttlS}s`)
    .setIssuer("conduit")
    .setAudience(l.audience)
    .sign(enc.encode(AUTH_SECRET()));
  const c = await cookies();
  c.set(l.cookie, tok, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: l.ttlS });
}

async function checkAndHitLimiter(l: Limiter): Promise<{ allowed: boolean; remaining: number; retryAfterSec?: number }> {
  const now = Date.now();
  const hits = await read(l);
  const recent = hits.filter((t) => now - t < l.windowMs);
  if (recent.length >= l.maxHits) {
    const oldest = Math.min(...recent);
    return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((l.windowMs - (now - oldest)) / 1000) };
  }
  recent.push(now);
  await write(l, recent);
  return { allowed: true, remaining: l.maxHits - recent.length };
}

export async function checkAndHit() {
  return checkAndHitLimiter(REQUEST_LIMITER);
}

export async function checkAndHitVerify() {
  return checkAndHitLimiter(VERIFY_LIMITER);
}
