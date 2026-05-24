import { NextResponse } from "next/server";
import { getSessionFromCookies, signApiToken } from "@/lib/auth";
import { BRIDGE_URL } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bridgeHttpBase() {
  return BRIDGE_URL.replace(/^ws/, "http");
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sess = await getSessionFromCookies();
  if (!sess) return NextResponse.json({ ok: false }, { status: 401 });
  const tok = await signApiToken(sess.email);
  const r = await fetch(`${bridgeHttpBase()}/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${tok}` },
    cache: "no-store",
  });
  const data = await r.json().catch(() => ({ ok: false }));
  return NextResponse.json(data, { status: r.status });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sess = await getSessionFromCookies();
  if (!sess) return NextResponse.json({ ok: false }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const tok = await signApiToken(sess.email);
  const r = await fetch(`${bridgeHttpBase()}/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await r.json().catch(() => ({ ok: false }));
  return NextResponse.json(data, { status: r.status });
}
