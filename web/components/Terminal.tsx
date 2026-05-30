"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { Square, RotateCcw, AlertTriangle } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

type Props = {
  sid: string;
  cwd?: string | null;
  theme: "light" | "dark";
};

type TermStatus = "connecting" | "open" | "closed" | "error";

// xterm.js is dynamically imported (ESM-only, no SSR possible)
export function Terminal({ sid, cwd, theme }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const reconnectRef = useRef<number>(0);
  const cancelledRef = useRef<boolean>(false);
  const [status, setStatus] = useState<TermStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  // Single source of truth for opening a WS. Stable across renders so both the
  // initial effect and the manual reconnect button use the exact same setup +
  // the same cancelledRef guard (prevents duplicate sockets on unmount).
  const connectWs = useCallback(async () => {
    if (cancelledRef.current) return;
    // Tear down any existing socket first so we never leak a second connection.
    if (wsRef.current) {
      try { wsRef.current.onclose = null; wsRef.current.close(); } catch {}
      wsRef.current = null;
    }
    try {
      setStatus("connecting");
      setError(null);
      const tokRes = await fetch("/api/chat/token", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sid }),
      });
      if (!tokRes.ok) throw new Error("Auth failed");
      if (cancelledRef.current) return;
      const { token, sessionId, bridgeUrl } = await tokRes.json();
      const url = `${bridgeUrl}/pty?token=${encodeURIComponent(token)}&sid=${encodeURIComponent(sessionId)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelledRef.current) { try { ws.close(); } catch {} return; }
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
        if (cancelledRef.current) return;
        // Only the *current* socket's onclose may trigger auto-reconnect.
        if (wsRef.current !== ws) return;
        setStatus("closed");
        // 1× auto-reconnect after 2s
        if (reconnectRef.current < 1) {
          reconnectRef.current++;
          setTimeout(() => { if (!cancelledRef.current) connectWs(); }, 2000);
        }
      };
      ws.onerror = () => {
        if (cancelledRef.current) return;
        setError("Bridge offline — is your host reachable? Tunnel up?");
        setStatus("error");
      };
    } catch (e: any) {
      if (cancelledRef.current) return;
      setError(e?.message || "Connection failed");
      setStatus("error");
    }
  }, [sid]);

  useEffect(() => {
    cancelledRef.current = false;
    let resizeObs: ResizeObserver | null = null;

    const cleanup = () => {
      cancelledRef.current = true;
      try { if (wsRef.current) wsRef.current.onclose = null; wsRef.current?.close(); } catch {}
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
      if (cancelledRef.current || !hostRef.current) return;

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

      // Resize observer on the host
      resizeObs = new ResizeObserver(() => {
        try { fit.fit(); } catch {}
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          try {
            wsRef.current.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          } catch {}
        }
      });
      resizeObs.observe(hostRef.current);

      // User input → WS
      term.onData((data) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          try { wsRef.current.send(JSON.stringify({ type: "input", data })); } catch {}
        }
      });

      connectWs();
    };

    init();
    return cleanup;
  }, [sid, theme, connectWs]);

  const sendSignal = (name: "SIGINT" | "SIGTERM") => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try { wsRef.current.send(JSON.stringify({ type: "signal", name })); } catch {}
    }
  };

  const reconnect = () => {
    reconnectRef.current = 0;
    const term = termRef.current;
    if (term) term.write(`\r\n\x1b[2m[reconnect…]\x1b[0m\r\n`);
    connectWs();
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
          {status === "open" ? "PTY connected" : status === "connecting" ? "connecting…" : status === "error" ? "Error" : "closed"}
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
          title="Reconnect"
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
