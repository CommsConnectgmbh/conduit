import { NextResponse } from "next/server";
import { getSessionFromCookies, signApiToken } from "@/lib/auth";
import { BRIDGE_URL } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bridgeHttpBase() {
  return BRIDGE_URL.replace(/^ws/, "http");
}

export async function GET(req: Request) {
  const sess = await getSessionFromCookies();
  if (!sess) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const q = url.searchParams.get("q") || "";

  const tok = await signApiToken(sess.email);
  const r = await fetch(`${bridgeHttpBase()}/api/files?q=${encodeURIComponent(q)}`, {
    headers: { authorization: `Bearer ${tok}` },
    cache: "no-store",
  });
  const data = await r.json().catch(() => ({ ok: false, error: "bad bridge response" }));
  return NextResponse.json(data, { status: r.status });
}
