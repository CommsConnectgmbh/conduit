"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Step = "email" | "code";

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (step === "code") setTimeout(() => codeRef.current?.focus(), 50); }, [step]);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setInfo(null); setLoading(true);
    try {
      const r = await fetch("/api/auth/request", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "Failed to send.");
      }
      setStep("code");
      setInfo("Code sent to your email.");
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setLoading(true);
    try {
      const clean = code.replace(/\D/g, "");
      const r = await fetch("/api/auth/verify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code: clean }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "Invalid code.");
      }
      router.replace("/");
      router.refresh();
    } catch (e) { setError((e as Error).message); setLoading(false); }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center px-5 py-10 bg-gradient-to-b from-ink-50 to-ink-100 dark:from-ink-950 dark:to-ink-900">
      <div className="w-full max-w-sm">
        <div className="mb-10 text-center">
          <div className="inline-flex items-center gap-2 mb-3">
            <span className="h-2 w-2 rounded-full bg-brand animate-pulse" />
            <span className="text-[11px] uppercase tracking-[0.18em] text-ink-500">Conduit</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="text-sm text-ink-500 dark:text-ink-400 mt-1">
            {step === "email" ? "With your email. Code arrives instantly." : "8-digit code from your email."}
          </p>
        </div>

        <div className="bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-800 rounded-2xl p-6 shadow-sm animate-slide-up">
          {step === "email" ? (
            <form onSubmit={requestCode} className="space-y-4">
              <label className="block">
                <span className="text-xs font-medium text-ink-600 dark:text-ink-400">Email</span>
                <input
                  type="email" required autoFocus inputMode="email" autoComplete="email"
                  value={email} onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full px-4 py-3 rounded-xl bg-ink-50 dark:bg-ink-800 border border-ink-200 dark:border-ink-700 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand transition text-[15px]"
                  placeholder="you@example.com"
                />
              </label>
              <button
                disabled={loading}
                className="w-full py-3 rounded-xl bg-ink-900 dark:bg-ink-50 text-ink-50 dark:text-ink-900 font-medium hover:opacity-90 disabled:opacity-50 transition active:scale-[0.99]"
              >
                {loading ? "Sending…" : "Request code"}
              </button>
            </form>
          ) : (
            <form onSubmit={verifyCode} className="space-y-4">
              <label className="block">
                <span className="text-xs font-medium text-ink-600 dark:text-ink-400">Code</span>
                <input
                  ref={codeRef}
                  type="text" inputMode="numeric" autoComplete="one-time-code" required
                  maxLength={9}
                  value={code}
                  onChange={(e) => {
                    const v = e.target.value.replace(/\D/g, "").slice(0, 8);
                    setCode(v.length > 4 ? `${v.slice(0, 4)} ${v.slice(4)}` : v);
                  }}
                  className="mt-1 w-full px-4 py-3 rounded-xl bg-ink-50 dark:bg-ink-800 border border-ink-200 dark:border-ink-700 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand transition font-mono text-2xl text-center tracking-[0.25em]"
                  placeholder="0000 0000"
                />
              </label>
              <button
                disabled={loading || code.replace(/\D/g, "").length !== 8}
                className="w-full py-3 rounded-xl bg-brand text-white font-medium hover:bg-brand-600 disabled:opacity-50 transition active:scale-[0.99]"
              >
                {loading ? "Checking…" : "Sign in"}
              </button>
              <button
                type="button"
                onClick={() => { setStep("email"); setCode(""); setError(null); setInfo(null); }}
                className="w-full py-2 text-sm text-ink-500 hover:text-ink-900 dark:hover:text-ink-50 transition"
              >
                Use a different email
              </button>
            </form>
          )}

          {error && <div className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</div>}
          {info && !error && <div className="mt-4 text-sm text-ink-500">{info}</div>}
        </div>

        <p className="text-center text-[11px] text-ink-400 mt-6">Private login — only allowlisted addresses receive codes.</p>
      </div>
    </div>
  );
}
