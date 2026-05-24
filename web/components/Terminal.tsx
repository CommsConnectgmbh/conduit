"use client";
import { useEffect, useRef, useState } from "react";
import { Square, RotateCcw, AlertTriangle } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

type Props = {
  sid: string;
  cwd?: string | null;
  theme: "light" | "dark";
};

type TermStatus = "connecting" | "open" | "closed" | "error";

// xterm.js wird dynamisch importiert (ESM-only, kein SSR möglich)
export function Terminal({ sid, cwd, theme }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const reconnectRef = useRef<number>(0);
  const [status, setStatus] = useState<TermStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let resizeObs: ResizeObserver | null = null;

    const cleanup = () => {
      cancelled = true;
      try { wsRef.current?.close(); } catch {}
      try { termRef.current?.dispose(); } catch {}
      resizeObs?.disconnect();
      wsRef.current = null;
      termRef.current = null;
      fitRef.current = null;
    };

    const init = async () => {
      const [{ Terminal: Xterm }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);
      if (cancelled || !hostRef.current) return;

      const term = new Xterm({
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        lineHeight: 1.2,
        scrollback: 5000,
        convertEol: false,
        theme: theme === "dark" ? darkTheme : lightTheme,
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(hostRef.current);
      fit.fit();
      termRef.current = term;
      fitRef.current = fit;

      // Resize-Observer auf den Host
      resizeObs = new ResizeObserver(() => {
        try { fit.fit(); } catch {}
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          try {
            wsRef.current.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          } catch {}
        }
      });
      resizeObs.observe(hostRef.current);

      // Input vom User → WS
      term.onData((data) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          try { wsRef.current.send(JSON.stringify({ type: "input", data })); } catch {}
        }
      });

      connectWs();
    };

    const connectWs = async () => {
      try {
        setStatus("connecting");
        setError(null);
        const tokRes = await fetch("/api/chat/token", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: sid }),
        });
        if (!tokRes.ok) throw new Error("Auth fehlgeschlagen");
        const { token, sessionId, bridgeUrl } = await tokRes.json();
        const url = `${bridgeUrl}/pty?token=${encodeURIComponent(token)}&sid=${encodeURIComponent(sessionId)}`;
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          setStatus("open");
          reconnectRef.current = 0;
          const term = termRef.current;
          if (term) {
            try { ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })); } catch {}
          }
        };
        ws.onmessage = (ev) => {
          let msg: any; try { msg = JSON.parse(ev.data); } catch { return; }
          if (msg.type === "data") {
            termRef.current?.write(msg.data);
          } else if (msg.type === "exit") {
            const code = msg.code ?? "?";
            termRef.current?.write(`\r\n\x1b[2m[exit ${code}${msg.signal ? ` (${msg.signal})` : ""}]\x1b[0m\r\n`);
            setStatus("closed");
          }
        };
        ws.onclose = () => {
          if (cancelled) return;
          setStatus("closed");
          // 1× Auto-Reconnect nach 2s
          if (reconnectRef.current < 1) {
            reconnectRef.current++;
            setTimeout(() => { if (!cancelled) connectWs(); }, 2000);
          }
        };
        ws.onerror = () => {
          setError("Bridge offline — Mac mini erreichbar? Tunnel up?");
          setStatus("error");
        };
      } catch (e: any) {
        setError(e?.message || "Verbindung fehlgeschlagen");
        setStatus("error");
      }
    };

    init();
    return cleanup;
  }, [sid, theme]);

  const sendSignal = (name: "SIGINT" | "SIGTERM") => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try { wsRef.current.send(JSON.stringify({ type: "signal", name })); } catch {}
    }
  };

  const reconnect = () => {
    try { wsRef.current?.close(); } catch {}
    reconnectRef.current = 0;
    // useEffect re-init? Wir triggern selbst:
    const term = termRef.current;
    if (term) term.write(`\r\n\x1b[2m[reconnect…]\x1b[0m\r\n`);
    // Trick: setStatus triggert kein re-effect; wir bauen die WS direkt neu
    setStatus("connecting");
    setError(null);
    setTimeout(() => {
      // Re-trigger by closing existing socket and letting onclose's auto-reconnect logic kick in
      // Falls onclose schon gefeuert hat, manuell anstoßen:
      (async () => {
        try {
          const tokRes = await fetch("/api/chat/token", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: sid }),
          });
          if (!tokRes.ok) throw new Error("Auth fehlgeschlagen");
          const { token, sessionId, bridgeUrl } = await tokRes.json();
          const url = `${bridgeUrl}/pty?token=${encodeURIComponent(token)}&sid=${encodeURIComponent(sessionId)}`;
          const ws = new WebSocket(url);
          wsRef.current = ws;
          ws.onopen = () => {
            setStatus("open");
            const t = termRef.current;
            if (t) try { ws.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows })); } catch {}
          };
          ws.onmessage = (ev) => {
            let msg: any; try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.type === "data") termRef.current?.write(msg.data);
            else if (msg.type === "exit") {
              termRef.current?.write(`\r\n\x1b[2m[exit ${msg.code ?? "?"}]\x1b[0m\r\n`);
              setStatus("closed");
            }
          };
          ws.onclose = () => setStatus("closed");
          ws.onerror = () => { setError("Bridge offline"); setStatus("error"); };
        } catch (e: any) {
          setError(e?.message || "Verbindung fehlgeschlagen");
          setStatus("error");
        }
      })();
    }, 50);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-200 dark:border-ink-800 text-xs">
        <span
          className={
            status === "open"
              ? "inline-block h-2 w-2 rounded-full bg-emerald-500"
              : status === "connecting"
              ? "inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse"
              : status === "error"
              ? "inline-block h-2 w-2 rounded-full bg-rose-500"
              : "inline-block h-2 w-2 rounded-full bg-ink-400"
          }
        />
        <span className="font-mono text-ink-600 dark:text-ink-300">
          {status === "open" ? "PTY verbunden" : status === "connecting" ? "verbinde…" : status === "error" ? "Fehler" : "geschlossen"}
        </span>
        {cwd && <span className="font-mono text-ink-400 dark:text-ink-500 hidden sm:inline">· {cwd.split("/").pop()}</span>}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => sendSignal("SIGINT")}
          disabled={status !== "open"}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-ink-200 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800 disabled:opacity-40"
          title="Ctrl-C (SIGINT)"
        >
          <Square className="h-3 w-3" /> Ctrl-C
        </button>
        <button
          type="button"
          onClick={reconnect}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-ink-200 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800"
          title="Neu verbinden"
        >
          <RotateCcw className="h-3 w-3" /> Reconnect
        </button>
      </div>
      {error && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-rose-600 dark:text-rose-400 border-b border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40">
          <AlertTriangle className="h-3.5 w-3.5" /> {error}
        </div>
      )}
      <div ref={hostRef} className="flex-1 bg-[#0b0d10] p-2 overflow-hidden" />
    </div>
  );
}

const darkTheme = {
  background: "#0b0d10",
  foreground: "#e5e7eb",
  cursor: "#a78bfa",
  black: "#1f2937",
  red: "#f87171",
  green: "#34d399",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e5e7eb",
  brightBlack: "#4b5563",
  brightRed: "#fca5a5",
  brightGreen: "#6ee7b7",
  brightYellow: "#fcd34d",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f3f4f6",
};

const lightTheme = {
  ...darkTheme,
  background: "#0b0d10",
  foreground: "#e5e7eb",
};
