import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { AUTH_SECRET } from "./config";

const COOKIE = "conduit_rl";
const enc = new TextEncoder();
const WINDOW_MS = 10 * 60 * 1000; // 10 min
const MAX_HITS = 5;

type Bucket = { hits: number[] };

async function read(): Promise<Bucket> {
  const c = await cookies();
  const tok = c.get(COOKIE)?.value;
  if (!tok) return { hits: [] };
  try {
    const { payload } = await jwtVerify(tok, enc.encode(AUTH_SECRET()), { issuer: "conduit", audience: "rl" });
    const hits = Array.isArray(payload.hits) ? (payload.hits as number[]) : [];
    return { hits };
  } catch { return { hits: [] }; }
}

async function write(hits: number[]) {
  const tok = await new SignJWT({ hits })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30m")
    .setIssuer("conduit")
    .setAudience("rl")
    .sign(enc.encode(AUTH_SECRET()));
  const c = await cookies();
  c.set(COOKIE, tok, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 30 * 60 });
}

export async function checkAndHit(): Promise<{ allowed: boolean; remaining: number; retryAfterSec?: number }> {
  const now = Date.now();
  const { hits } = await read();
  const recent = hits.filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_HITS) {
    const oldest = Math.min(...recent);
    return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((WINDOW_MS - (now - oldest)) / 1000) };
  }
  recent.push(now);
  await write(recent);
  return { allowed: true, remaining: MAX_HITS - recent.length };
}
