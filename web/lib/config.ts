export const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || "")
  .toLowerCase()
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const SESSION_COOKIE = "conduit_session";
export const PENDING_COOKIE = "conduit_pending";
export const SESSION_TTL_S = 60 * 60 * 24 * 30; // 30 days
export const PENDING_TTL_S = 60 * 10; // 10 min

export const BRIDGE_URL = process.env.BRIDGE_URL || "ws://127.0.0.1:8787";
export const APP_URL = process.env.APP_URL || "http://localhost:3030";
export const FROM_EMAIL = process.env.FROM_EMAIL || "conduit@example.com";
export const FROM_NAME = process.env.FROM_NAME || "Conduit";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export const AUTH_SECRET = () => required("AUTH_SECRET");
export const BRIDGE_SECRET = () => required("BRIDGE_SECRET");
export const RESEND_API_KEY = () => required("RESEND_API_KEY");
