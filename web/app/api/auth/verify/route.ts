import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ALLOWED_EMAILS, PENDING_COOKIE, SESSION_COOKIE, SESSION_TTL_S } from "@/lib/config";
import { verifyPending } from "@/lib/otp";
import { signSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { email: rawEmail, code: rawCode } = await req.json().catch(() => ({}));
  const email = String(rawEmail || "").trim().toLowerCase();
  const code = String(rawCode || "").replace(/\D/g, "");

  if (!email || code.length !== 8) {
    return NextResponse.json({ ok: false, error: "Email and 8-digit code required." }, { status: 400 });
  }
  if (!ALLOWED_EMAILS.includes(email)) {
    return NextResponse.json({ ok: false, error: "Wrong code." }, { status: 401 });
  }

  const c = await cookies();
  const pending = c.get(PENDING_COOKIE)?.value;
  if (!pending) {
    return NextResponse.json({ ok: false, error: "Code expired — request a new one." }, { status: 401 });
  }

  const res = await verifyPending(pending, email, code);
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.reason }, { status: 401 });
  }

  const session = await signSession(email);
  c.set(SESSION_COOKIE, session, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_S,
  });
  c.delete(PENDING_COOKIE);

  return NextResponse.json({ ok: true });
}
