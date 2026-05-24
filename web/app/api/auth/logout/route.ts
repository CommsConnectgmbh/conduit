import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { PENDING_COOKIE, SESSION_COOKIE } from "@/lib/config";

export const runtime = "nodejs";

export async function POST() {
  const c = await cookies();
  c.delete(SESSION_COOKIE);
  c.delete(PENDING_COOKIE);
  return NextResponse.json({ ok: true });
}
