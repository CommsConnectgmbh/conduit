import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function sessionUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // Fallback (RFC4122 v4)
  const buf = new Uint8Array(16);
  (crypto as any).getRandomValues(buf);
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export type ChatMessage = { id: string; role: "user" | "assistant"; content: string; ts: number };
export type SessionStatus = "idle" | "connecting" | "streaming" | "error";
export type SessionUsage = {
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_create: number;
  cost_usd: number;
  turns: number;
};
export type SessionMode = "chat" | "terminal";
export type ChatSession = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
  loaded?: boolean;
  status?: SessionStatus;
  statusMsg?: string | null;
  cwd?: string | null;
  usage?: SessionUsage;
  mode?: SessionMode;
};

export const ZERO_USAGE: SessionUsage = {
  tokens_in: 0, tokens_out: 0, cache_read: 0, cache_create: 0, cost_usd: 0, turns: 0,
};

export const PROJECT_PRESETS: { label: string; path: string }[] = [
  { label: "Default", path: "" },
];

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

export function fmtUsd(n: number): string {
  if (!n) return "$0";
  if (n < 0.01) return "<$0.01";
  return "$" + n.toFixed(2);
}
