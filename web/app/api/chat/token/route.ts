import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getSessionFromCookies, signBridgeToken } from "@/lib/auth";
import { BRIDGE_URL } from "@/lib/config";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const sess = await getSessionFromCookies();
  if (!sess) return NextResponse.json({ ok: false }, { status: 401 });
  const { sessionId: requested } = await req.json().catch(() => ({}));
  const sessionId = (typeof requested === "string" && requested.length > 0) ? requested : randomUUID();
  const token = await signBridgeToken(sess.email, sessionId);
  return NextResponse.json({ ok: true, token, sessionId, bridgeUrl: BRIDGE_URL });
}
