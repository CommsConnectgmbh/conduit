import { NextResponse } from "next/server";
import { getSessionFromCookies, signApiToken } from "@/lib/auth";
import { BRIDGE_URL } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function bridgeHttpBase() {
  return BRIDGE_URL.replace(/^ws/, "http");
}

export async function POST(req: Request) {
  const sess = await getSessionFromCookies();
  if (!sess) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) {
    return NextResponse.json({ ok: false, error: "expected multipart/form-data" }, { status: 400 });
  }

  const tok = await signApiToken(sess.email);
  const body = Buffer.from(await req.arrayBuffer());

  const r = await fetch(`${bridgeHttpBase()}/api/transcribe`, {
    method: "POST",
    body,
    headers: {
      authorization: `Bearer ${tok}`,
      "content-type": ct,
    },
  });
  const data = await r.json().catch(() => ({ ok: false, error: "bad bridge response" }));
  return NextResponse.json(data, { status: r.status });
}
