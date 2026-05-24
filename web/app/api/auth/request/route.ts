import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ALLOWED_EMAILS, PENDING_COOKIE, PENDING_TTL_S } from "@/lib/config";
import { generateCode, signPending } from "@/lib/otp";
import { sendOtpMail } from "@/lib/mail";
import { checkAndHit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { email: rawEmail } = await req.json().catch(() => ({}));
  const email = String(rawEmail || "").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return NextResponse.json({ ok: false, error: "Mail-Adresse fehlt." }, { status: 400 });
  }

  const rl = await checkAndHit();
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: `Zu viele Versuche. In ${Math.ceil((rl.retryAfterSec || 60) / 60)} min wieder.` },
      { status: 429, headers: { "retry-after": String(rl.retryAfterSec || 60) } },
    );
  }

  if (!ALLOWED_EMAILS.includes(email)) {
    await new Promise((r) => setTimeout(r, 400));
    return NextResponse.json({ ok: true });
  }

  const code = generateCode();
  const pending = await signPending(email, code);

  try {
    await sendOtpMail(email, code);
  } catch (e) {
    console.error("mail send failed", e);
    return NextResponse.json({ ok: false, error: "Mail-Versand fehlgeschlagen." }, { status: 500 });
  }

  const c = await cookies();
  c.set(PENDING_COOKIE, pending, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: PENDING_TTL_S,
  });

  return NextResponse.json({ ok: true });
}
