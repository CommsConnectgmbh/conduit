"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Send, Mic, MicOff, Square, Menu, LogOut, Sun, Moon, Trash2, Paperclip, FileText, Folder, Image as ImageIcon, X, History, Layers } from "lucide-react";
import {
  cn, uid, sessionUuid, fmtTokens, fmtUsd,
  ZERO_USAGE,
  type ChatSession, type ChatMessage, type SessionStatus, type SessionUsage,
} from "@/lib/utils";
import { Markdown } from "./Markdown";
import { Terminal } from "./Terminal";

type SessionRuntime = {
  ws: WebSocket;
  ping: ReturnType<typeof setInterval>;
  watchdog: ReturnType<typeof setTimeout>;
  assistantId: string;
  reconnectsLeft: number;
};

const PING_INTERVAL_MS = 25_000;
const WATCHDOG_MS = 600_000; // 10 min ohne Chunk/Heartbeat → tot
const RECONNECT_DELAY_MS = 2_000;

export function Chat({ email }: { email: string }) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [historyLoading, setHistoryLoading] = useState(true);
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [tabsDrawerOpen, setTabsDrawerOpen] = useState(false);
  const [attachments, setAttachments] = useState<{ path: string; name: string; kind: "image" | "file" }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mentionState, setMentionState] = useState<
    | null
    | {
        anchor: number;          // index of the "@" in draft
        query: string;           // text after "@"
        results: { path: string; kind: "file" | "dir" }[];
        loading: boolean;
        cursor: number;          // selected index
      }
  >(null);

  // Per-Session WS-Runtime (kein globaler wsRef mehr — pro sid eine Map-Entry).
  const wsMap = useRef<Map<string, SessionRuntime>>(new Map());

  // Voice (MediaRecorder + whisper.cpp)
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const handsFreeRef = useRef(false);
  const draftRef = useRef("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { draftRef.current = draft; }, [draft]);

  useEffect(() => {
    const t = (typeof window !== "undefined" && localStorage.getItem("theme")) as "light" | "dark" | null;
    const dark = t ? t === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    setTheme(dark ? "dark" : "light");
    try {
      const stored = JSON.parse(localStorage.getItem("conduit-open-tabs") || "[]");
      if (Array.isArray(stored)) setOpenTabIds(stored.filter((x: unknown) => typeof x === "string"));
    } catch {}
    refreshSessions();

    return () => {
      for (const sid of [...wsMap.current.keys()]) teardown(sid);
      stopVoice();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try { localStorage.setItem("theme", theme); } catch {}
  }, [theme]);

  useEffect(() => {
    try { localStorage.setItem("conduit-open-tabs", JSON.stringify(openTabIds)); } catch {}
  }, [openTabIds]);

  function openInTab(sid: string) {
    setOpenTabIds((prev) => prev.includes(sid) ? prev : [...prev, sid]);
    setActiveId(sid);
    setSidebarOpen(false);
    setTabsDrawerOpen(false);
  }

  function closeTab(sid: string) {
    setOpenTabIds((prev) => {
      const idx = prev.indexOf(sid);
      if (idx < 0) return prev;
      const next = prev.filter((id) => id !== sid);
      if (activeId === sid) {
        if (next.length === 0) setActiveId(null);
        else setActiveId(next[Math.min(idx, next.length - 1)]);
      }
      return next;
    });
  }

  async function refreshSessions() {
    try {
      const r = await fetch("/api/sessions", { cache: "no-store" });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "fetch failed");
      const modeMap = loadModeMap();
      const fetched: ChatSession[] = (j.sessions || []).map((s: any) => ({
        id: s.id, title: s.title || "New chat", updatedAt: s.updatedAt,
        messages: [], loaded: false, status: "idle", statusMsg: null,
        cwd: s.cwd ?? null,
        usage: s.usage ? { ...ZERO_USAGE, ...s.usage } : { ...ZERO_USAGE },
        mode: modeMap[s.id] || "chat",
      }));
      setSessions((prev) => {
        // Merge: keep loaded messages and live status from prev where IDs match.
        // cwd + usage come from server and always win.
        const map = new Map(prev.map((p) => [p.id, p]));
        return fetched.map((f) => {
          const old = map.get(f.id);
          if (!old) return f;
          return {
            ...f,
            messages: old.loaded ? old.messages : f.messages,
            loaded: old.loaded ?? false,
            status: old.status ?? "idle",
            statusMsg: old.statusMsg ?? null,
            mode: old.mode ?? f.mode,
          };
        });
      });
    } catch (e) {
      // history failure — show on active session if any
      if (activeId) setStatusFor(activeId, "error", "Failed to load history");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function loadMessages(sid: string) {
    try {
      const r = await fetch(`/api/sessions/${sid}/messages`, { cache: "no-store" });
      const j = await r.json();
      if (!j.ok) return;
      const msgs: ChatMessage[] = (j.messages || []).map((m: any) => ({
        id: m.id, role: m.role, content: m.content, ts: m.ts,
      }));
      setSessions((prev) => prev.map((s) => s.id === sid ? { ...s, messages: msgs, loaded: true } : s));
    } catch {}
  }

  const active = useMemo(() => sessions.find((s) => s.id === activeId) || null, [sessions, activeId]);

  useEffect(() => {
    if (!activeId) return;
    const s = sessions.find((x) => x.id === activeId);
    if (s && !s.loaded) loadMessages(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [active?.messages.length, active?.status]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [draft]);

  function newSession(mode: "chat" | "terminal" = "chat"): ChatSession {
    // Inherit cwd from currently active session so context carries between tabs.
    const inheritCwd = sessions.find((x) => x.id === activeId)?.cwd ?? null;
    const s: ChatSession = {
      id: sessionUuid(),
      title: mode === "terminal" ? "Terminal" : "New chat",
      updatedAt: Date.now(),
      messages: [], loaded: true, status: "idle", statusMsg: null,
      cwd: inheritCwd, usage: { ...ZERO_USAGE }, mode,
    };
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    setOpenTabIds((prev) => prev.includes(s.id) ? prev : [...prev, s.id]);
    setSidebarOpen(false);
    setTabsDrawerOpen(false);
    saveModeForSid(s.id, mode);
    // Persist cwd server-side so PTY-mode (which spawns immediately) sees it
    if (mode === "terminal" && inheritCwd) {
      setSessionCwd(s.id, inheritCwd);
    }
    return s;
  }

  function loadModeMap(): Record<string, "chat" | "terminal"> {
    if (typeof window === "undefined") return {};
    try { return JSON.parse(localStorage.getItem("conduit-session-modes") || "{}"); } catch { return {}; }
  }
  function saveModeForSid(sid: string, mode: "chat" | "terminal") {
    if (typeof window === "undefined") return;
    try {
      const m = loadModeMap();
      m[sid] = mode;
      localStorage.setItem("conduit-session-modes", JSON.stringify(m));
    } catch {}
  }

  function addUsageTo(sid: string, delta: SessionUsage) {
    setSessions((prev) => prev.map((s) => {
      if (s.id !== sid) return s;
      const cur = s.usage ?? { ...ZERO_USAGE };
      return {
        ...s,
        usage: {
          tokens_in:    cur.tokens_in    + (delta.tokens_in    || 0),
          tokens_out:   cur.tokens_out   + (delta.tokens_out   || 0),
          cache_read:   cur.cache_read   + (delta.cache_read   || 0),
          cache_create: cur.cache_create + (delta.cache_create || 0),
          cost_usd:     cur.cost_usd     + (delta.cost_usd     || 0),
          turns:        cur.turns        + 1,
        },
      };
    }));
  }

  async function setSessionCwd(sid: string, cwd: string | null) {
    // Optimistic update
    setSessions((prev) => prev.map((s) => s.id === sid ? { ...s, cwd } : s));
    try {
      const r = await fetch(`/api/sessions/${sid}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: cwd ?? "" }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) {
        // Revert + show error
        setStatusFor(sid, "error", `Projekt konnte nicht gesetzt werden: ${j.error || r.status}`);
      }
    } catch (e) {
      setStatusFor(sid, "error", `Projekt: ${(e as Error).message}`);
    }
  }

  async function deleteSession(id: string) {
    teardown(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setOpenTabIds((prev) => prev.filter((x) => x !== id));
    if (activeId === id) setActiveId(null);
    try { await fetch(`/api/sessions/${id}`, { method: "DELETE" }); } catch {}
  }

  function setStatusFor(sid: string, status: SessionStatus, msg?: string | null) {
    setSessions((prev) => prev.map((s) => s.id === sid ? { ...s, status, statusMsg: msg ?? null } : s));
  }

  function patchMessage(sid: string, mid: string, delta: Partial<ChatMessage>) {
    setSessions((prev) =>
      prev.map((s) => s.id !== sid ? s : ({
        ...s, updatedAt: Date.now(),
        messages: s.messages.map((m) => m.id !== mid ? m : ({ ...m, ...delta })),
      }))
    );
  }

  function appendMessage(sid: string, msg: ChatMessage) {
    setSessions((prev) =>
      prev.map((s) => s.id !== sid ? s : ({
        ...s, updatedAt: Date.now(), messages: [...s.messages, msg],
        title: s.messages.length === 0 && msg.role === "user" ? truncate(msg.content, 48) : s.title,
      }))
    );
  }

  function appendChunkTo(sid: string, mid: string, text: string) {
    setSessions((prev) =>
      prev.map((s) => s.id !== sid ? s : ({
        ...s, updatedAt: Date.now(),
        messages: s.messages.map((m) => m.id !== mid ? m : ({ ...m, content: m.content + text })),
      }))
    );
  }

  function teardown(sid: string) {
    const rt = wsMap.current.get(sid);
    if (!rt) return;
    clearInterval(rt.ping);
    clearTimeout(rt.watchdog);
    try { rt.ws.close(); } catch {}
    wsMap.current.delete(sid);
  }

  async function send(content: string, targetSid?: string) {
    const text = content.trim();
    if (!text && attachments.length === 0) return;

    let session: ChatSession | null = targetSid
      ? (sessions.find((s) => s.id === targetSid) || null)
      : active;

    if (!session || session.status === "streaming" || session.status === "connecting") {
      if (!targetSid) session = newSession();
      else {
        setStatusFor(session!.id, "error", "Reply still running — please stop it.");
        return;
      }
    }

    const sid = session.id;

    // Prepend any attachments as referenced paths so claude can Read/See them.
    let prefix = "";
    if (attachments.length > 0) {
      const lines = attachments.map((a) =>
        a.kind === "image"
          ? `Bild-Anhang: ${a.path}`
          : `Datei-Anhang: ${a.path}`,
      );
      prefix = lines.join("\n") + "\n\n";
    }
    const fullPrompt = (prefix + text).trim();

    setDraft("");
    setAttachments([]);
    setMentionState(null);

    const userMsgId = uid();
    appendMessage(sid, { id: userMsgId, role: "user", content: fullPrompt, ts: Date.now() });

    const assistantId = uid();
    appendMessage(sid, { id: assistantId, role: "assistant", content: "", ts: Date.now() });

    setStatusFor(sid, "connecting");
    await openWsAndSend(sid, fullPrompt, userMsgId, assistantId, 1);
  }

  // ------------- @-File-Mentions -------------
  const mentionAbortRef = useRef<AbortController | null>(null);

  function detectMention(value: string, caret: number) {
    // Look back from caret to find the most recent "@" not preceded by alnum
    let i = caret - 1;
    while (i >= 0) {
      const ch = value[i];
      if (ch === "@") {
        if (i > 0 && /[a-zA-Z0-9_/.\\-]/.test(value[i - 1])) return null; // mid-word @ → email-like
        const query = value.slice(i + 1, caret);
        if (/\s/.test(query)) return null;
        if (query.length > 40) return null;
        return { anchor: i, query };
      }
      if (/\s/.test(ch)) return null;
      i--;
    }
    return null;
  }

  async function fetchMentions(query: string) {
    mentionAbortRef.current?.abort();
    const ctrl = new AbortController();
    mentionAbortRef.current = ctrl;
    try {
      const r = await fetch(`/api/files?q=${encodeURIComponent(query)}`, { signal: ctrl.signal, cache: "no-store" });
      const j = await r.json();
      if (!ctrl.signal.aborted) {
        setMentionState((prev) => prev ? { ...prev, results: j.files || [], loading: false, cursor: 0 } : prev);
      }
    } catch {
      if (!ctrl.signal.aborted) {
        setMentionState((prev) => prev ? { ...prev, results: [], loading: false } : prev);
      }
    }
  }

  function applyMention(picked: { path: string }) {
    if (!mentionState) return;
    const ta = taRef.current;
    const before = draft.slice(0, mentionState.anchor);
    const afterCaret = ta ? ta.selectionStart ?? draft.length : draft.length;
    const after = draft.slice(afterCaret);
    const inserted = picked.path + " ";
    const next = before + inserted + after;
    setDraft(next);
    setMentionState(null);
    requestAnimationFrame(() => {
      if (ta) {
        const pos = before.length + inserted.length;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  }

  function onDraftChange(value: string, caret: number) {
    setDraft(value);
    const m = detectMention(value, caret);
    if (!m) { setMentionState(null); return; }
    if (m.query.length < 2) {
      setMentionState({ anchor: m.anchor, query: m.query, results: [], loading: false, cursor: 0 });
      return;
    }
    setMentionState((prev) => ({
      anchor: m.anchor,
      query: m.query,
      results: prev?.query === m.query ? prev.results : (prev?.results ?? []),
      loading: true,
      cursor: 0,
    }));
    void fetchMentions(m.query);
  }

  // ------------- Attachments (paste + drag) -------------
  async function uploadBlob(blob: Blob, name: string, kind: "image" | "file") {
    setUploading(true);
    try {
      const r = await fetch("/api/paste", {
        method: "POST",
        headers: { "content-type": blob.type || (kind === "image" ? "image/png" : "application/octet-stream") },
        body: blob,
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setAttachments((prev) => [...prev, { path: j.path, name, kind }]);
    } catch (e) {
      if (activeId) setStatusFor(activeId, "error", `Upload: ${(e as Error).message}`);
    } finally {
      setUploading(false);
    }
  }

  function onPaste(e: React.ClipboardEvent) {
    const items = Array.from(e.clipboardData?.items || []);
    const file = items.find((it) => it.kind === "file" && (it.type.startsWith("image/") || it.type === "application/pdf"));
    if (!file) return;
    const f = file.getAsFile();
    if (!f) return;
    e.preventDefault();
    const kind = f.type.startsWith("image/") ? "image" : "file";
    void uploadBlob(f, f.name || `pasted-${Date.now()}`, kind);
  }

  function onDropFiles(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files || []);
    for (const f of files) {
      const kind = f.type.startsWith("image/") ? "image" : "file";
      void uploadBlob(f, f.name, kind);
    }
  }

  async function openWsAndSend(
    sid: string,
    text: string,
    userMsgId: string,
    assistantId: string,
    reconnectsLeft: number,
  ) {
    try {
      const tokRes = await fetch("/api/chat/token", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sid }),
      });
      if (!tokRes.ok) throw new Error("Auth failed.");
      const { token, sessionId, bridgeUrl } = await tokRes.json();
      const url = `${bridgeUrl}/ws?token=${encodeURIComponent(token)}&sid=${encodeURIComponent(sessionId)}`;
      const ws = new WebSocket(url);
      let chunksReceived = 0;

      const armWatchdog = () => {
        const rt = wsMap.current.get(sid);
        if (!rt) return;
        clearTimeout(rt.watchdog);
        rt.watchdog = setTimeout(() => {
          patchMessage(sid, assistantId, { content: "**⚠ Bridge antwortet nicht** (10 min still, getrennt). Erneut senden zum Versuch." });
          setStatusFor(sid, "error", "Bridge not responding.");
          teardown(sid);
        }, WATCHDOG_MS);
      };

      const ping = setInterval(() => {
        try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
      }, PING_INTERVAL_MS);

      // Platzhalter-watchdog, wird in armWatchdog() ersetzt
      const watchdog = setTimeout(() => {}, WATCHDOG_MS);

      wsMap.current.set(sid, { ws, ping, watchdog, assistantId, reconnectsLeft });
      armWatchdog();

      const tryReconnect = (reason: string): boolean => {
        const cur = wsMap.current.get(sid);
        if (!cur || cur.ws !== ws) return false;
        // Nur reconnecten, wenn noch nichts gestreamt wurde — sonst landet ein zweiter Prompt
        // beim laufenden Child (stale-kill) und bricht den Stream ab.
        if (chunksReceived > 0) return false;
        if (reconnectsLeft <= 0) return false;
        teardown(sid);
        setStatusFor(sid, "connecting");
        setTimeout(() => {
          openWsAndSend(sid, text, userMsgId, assistantId, reconnectsLeft - 1);
        }, RECONNECT_DELAY_MS);
        return true;
      };

      ws.onopen = () => {
        setStatusFor(sid, "streaming");
        try {
          ws.send(JSON.stringify({
            type: "prompt", content: text,
            userMessageId: userMsgId, assistantMessageId: assistantId,
          }));
        } catch {}
        armWatchdog();
      };
      ws.onmessage = (ev) => {
        let msg: any; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "chunk") {
          chunksReceived++;
          appendChunkTo(sid, assistantId, String(msg.text || ""));
          armWatchdog();
        } else if (msg.type === "usage") {
          addUsageTo(sid, msg.delta as SessionUsage);
          armWatchdog();
        } else if (msg.type === "started") {
          armWatchdog();
        } else if (msg.type === "heartbeat") {
          // Bridge says: Claude still thinking / tool running — watchdog reset, no UI update
          armWatchdog();
        } else if (msg.type === "done") {
          setStatusFor(sid, "idle");
          teardown(sid);
          refreshSessions();
        } else if (msg.type === "error") {
          patchMessage(sid, assistantId, { content: `**Bridge error:** ${msg.message || "unknown"}` });
          setStatusFor(sid, "error", String(msg.message || "Bridge error"));
          teardown(sid);
        } else if (msg.type === "pong") {
          // ack — kein watchdog-reset, damit ein stiller claude-Hang erkannt wird
        }
      };
      ws.onclose = () => {
        const cur = wsMap.current.get(sid);
        if (cur && cur.ws === ws) {
          if (tryReconnect("close")) return;
          setStatusFor(sid, "error", "Connection dropped — send again.");
          teardown(sid);
        }
      };
      ws.onerror = () => {
        if (tryReconnect("error")) return;
        setStatusFor(sid, "error", "Bridge offline — host reachable? Tunnel up?");
        patchMessage(sid, assistantId, { content: "**Connection to bridge failed.** Check your host + tunnel." });
        teardown(sid);
      };
    } catch (e) {
      setStatusFor(sid, "error", (e as Error).message);
    }
  }

  function stop(targetSid?: string) {
    const sid = targetSid ?? activeId;
    if (!sid) return;
    const rt = wsMap.current.get(sid);
    if (rt) {
      try { rt.ws.send(JSON.stringify({ type: "stop" })); } catch {}
    }
    teardown(sid);
    setStatusFor(sid, "idle");
  }

  // ------------- Voice (MediaRecorder + Whisper) -------------
  // Klick = Push-to-Talk (Aufnahme stoppt nach 1.5 s Stille, dann transkribieren + auto-submit).
  // Double-click / long-press = hands-free: after every submit the mic keeps listening.

  function pickMime(): string | undefined {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4",
      "audio/aac",
    ];
    for (const m of candidates) {
      if ((window as any).MediaRecorder?.isTypeSupported?.(m)) return m;
    }
    return undefined;
  }

  function extForMime(m?: string): string {
    if (!m) return "webm";
    if (m.includes("mp4") || m.includes("aac")) return "m4a";
    if (m.includes("webm")) return "webm";
    if (m.includes("ogg") || m.includes("opus")) return "ogg";
    return "webm";
  }

  async function startVoice(opts: { handsFree?: boolean } = {}) {
    if (recording || transcribing) return;
    if (!("MediaRecorder" in window) || !navigator.mediaDevices?.getUserMedia) {
      if (activeId) setStatusFor(activeId, "error", "Voice recording not available in this browser.");
      return;
    }
    handsFreeRef.current = !!opts.handsFree;
    setHandsFree(handsFreeRef.current);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      handsFreeRef.current = false;
      setHandsFree(false);
      if (activeId) setStatusFor(activeId, "error", "Microphone access denied.");
      return;
    }
    mediaStreamRef.current = stream;

    const mime = pickMime();
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    } catch {
      mr = new MediaRecorder(stream);
    }
    mediaRecRef.current = mr;
    const chunks: BlobPart[] = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

    const wasHandsFree = handsFreeRef.current;
    mr.onstop = async () => {
      // Audio-Stream sofort freigeben (sonst bleibt iOS Mikro-Icon rot stehen).
      try { stream.getTracks().forEach((t) => t.stop()); } catch {}
      mediaStreamRef.current = null;
      try { audioCtxRef.current?.close(); } catch {}
      audioCtxRef.current = null;
      setRecording(false);

      const blob = new Blob(chunks, { type: mr.mimeType || mime || "audio/webm" });
      if (blob.size < 1500) {
        // Zu wenig Audio (Klick ohne sprechen oder direkter Cancel)
        if (wasHandsFree && handsFreeRef.current) {
          // In hands-free mode, kick off the next round immediately — no empty send
          setTimeout(() => startVoice({ handsFree: true }), 100);
        }
        return;
      }
      await transcribeAndSubmit(blob, wasHandsFree);
    };

    mr.start();
    setRecording(true);
    // Start VAD watcher: stop recording 1.5 s nach Stille (sobald gesprochen wurde)
    startSilenceWatch(stream, mr);
  }

  function startSilenceWatch(stream: MediaStream, mr: MediaRecorder) {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return; // no VAD → user muss manuell stoppen
    const ac: AudioContext = new AC();
    audioCtxRef.current = ac;
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0.6;
    src.connect(an);
    const data = new Uint8Array(an.fftSize);

    const VOICE_THRESHOLD = 14;     // 0..127 amplitude offset
    const SILENCE_HOLD_MS = 1500;
    const MAX_RECORD_MS = 30_000;   // hard cap

    let spoke = false;
    let silentSince = 0;
    const startedAt = performance.now();

    const loop = () => {
      if (mr.state !== "recording") { try { ac.close(); } catch {} return; }
      const now = performance.now();
      an.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i] - 128);
        if (v > peak) peak = v;
      }
      if (peak > VOICE_THRESHOLD) {
        spoke = true;
        silentSince = 0;
      } else {
        if (silentSince === 0) silentSince = now;
        else if (spoke && now - silentSince > SILENCE_HOLD_MS) {
          try { mr.stop(); } catch {}
          return;
        }
      }
      if (now - startedAt > MAX_RECORD_MS) {
        try { mr.stop(); } catch {}
        return;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  function stopVoice() {
    handsFreeRef.current = false;
    setHandsFree(false);
    const mr = mediaRecRef.current;
    if (mr && mr.state === "recording") {
      try { mr.stop(); } catch {}
    } else {
      // Falls nicht im recording state, Stream selbst stoppen
      try { mediaStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
      mediaStreamRef.current = null;
      try { audioCtxRef.current?.close(); } catch {}
      audioCtxRef.current = null;
      setRecording(false);
    }
    mediaRecRef.current = null;
  }

  async function transcribeAndSubmit(blob: Blob, restartHandsFree: boolean) {
    setTranscribing(true);
    try {
      const fd = new FormData();
      fd.append("file", blob, `voice.${extForMime(blob.type)}`);
      const lang = typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("de") ? "de" : "en";
      fd.append("language", lang);
      fd.append("response_format", "json");
      fd.append("temperature", "0.0");

      const r = await fetch("/api/transcribe", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        const err = j?.error || `HTTP ${r.status}`;
        if (activeId) setStatusFor(activeId, "error", `Transkription fehlgeschlagen: ${err}`);
        return;
      }
      const text = String(j.text || "").trim();
      if (!text) return;

      // In Draft schreiben (sichtbar) und gleich senden
      const merged = (draftRef.current.trim() ? draftRef.current.trim() + " " : "") + text;
      draftRef.current = merged;
      setDraft(merged);
      // kurzes Tick, damit User den Text aufblitzen sieht, dann senden
      setTimeout(() => {
        const t = draftRef.current.trim();
        if (!t) return;
        send(t);
        draftRef.current = "";
        if (restartHandsFree && handsFreeRef.current) {
          setTimeout(() => startVoice({ handsFree: true }), 200);
        }
      }, 100);
    } catch (e) {
      if (activeId) setStatusFor(activeId, "error", `Transkription: ${(e as Error).message}`);
    } finally {
      setTranscribing(false);
    }
  }

  // Long-press detection for hands-free on mobile (double-click is unreliable on iOS).
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const LONG_PRESS_MS = 500;

  function micPointerDown() {
    longPressFiredRef.current = false;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      if (!recording) startVoice({ handsFree: true });
    }, LONG_PRESS_MS);
  }

  function micPointerUp() {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    if (longPressFiredRef.current) return; // long-press hat schon gestartet
    // Normaler Klick
    if (recording) stopVoice();
    else startVoice({ handsFree: false });
  }

  function micPointerCancel() {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
  }

  // ------------- Auth -------------
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  const status: SessionStatus = active?.status ?? "idle";
  const statusMsg = active?.statusMsg ?? null;
  const busy = status === "streaming" || status === "connecting";

  const anyBusyCount = sessions.filter((s) => s.status === "streaming" || s.status === "connecting").length;

  const openSessions = openTabIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter((s): s is ChatSession => !!s);

  return (
    <div className="h-dvh flex bg-ink-50 dark:bg-ink-950 text-ink-900 dark:text-ink-100">
      {/* History Sidebar — desktop always, mobile drawer */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-72 bg-white dark:bg-ink-900 border-r border-ink-200 dark:border-ink-800 transition-transform safe-top safe-bottom flex flex-col",
          "md:static md:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="h-14 px-4 flex items-center justify-between border-b border-ink-200 dark:border-ink-800">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-brand" />
            <span className="text-[11px] uppercase tracking-[0.18em] text-ink-500">Verlauf</span>
            {anyBusyCount > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-brand/10 text-brand">
                {anyBusyCount} aktiv
              </span>
            )}
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden p-2 rounded-lg hover:bg-ink-100 dark:hover:bg-ink-800"
            aria-label="Close"
          ><X className="w-4 h-4" /></button>
        </div>

        <div className="p-3">
          <button
            onClick={() => newSession("chat")}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-ink-900 dark:bg-ink-50 text-ink-50 dark:text-ink-900 text-sm font-medium hover:opacity-90 transition active:scale-[0.99]"
          >
            <Plus className="w-4 h-4" /> Neuer Chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-3 scrollbar-thin">
          {historyLoading && (
            <div className="px-3 py-4 text-center text-xs text-ink-400">Lade Verlauf …</div>
          )}
          {!historyLoading && sessions.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-ink-400">Noch keine Chats</div>
          )}
          <ul className="space-y-0.5">
            {sessions.map((s) => {
              const isOpen = openTabIds.includes(s.id);
              return (
                <li key={s.id}>
                  <div
                    onClick={() => openInTab(s.id)}
                    className={cn(
                      "group cursor-pointer w-full px-3 py-2 rounded-lg text-sm flex items-center gap-2",
                      activeId === s.id
                        ? "bg-ink-100 dark:bg-ink-800 text-ink-900 dark:text-ink-50"
                        : "hover:bg-ink-100/60 dark:hover:bg-ink-800/60 text-ink-600 dark:text-ink-400"
                    )}
                  >
                    {(s.status === "streaming" || s.status === "connecting") ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-brand animate-pulse shrink-0" />
                    ) : s.status === "error" ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
                    ) : isOpen ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-ink-400 dark:bg-ink-500 shrink-0" title="Open in tab" />
                    ) : (
                      <span className="h-1.5 w-1.5 shrink-0" />
                    )}
                    <span className="flex-1 truncate">{s.title}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); if (confirm("Delete chat?")) deleteSession(s.id); }}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-ink-200 dark:hover:bg-ink-700"
                      aria-label="Delete"
                    ><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="border-t border-ink-200 dark:border-ink-800 p-3 flex items-center justify-between">
          <div className="text-[11px] text-ink-500 truncate">{email}</div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="p-2 rounded-lg hover:bg-ink-100 dark:hover:bg-ink-800"
              aria-label="Theme"
            >{theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}</button>
            <button
              onClick={logout}
              className="p-2 rounded-lg hover:bg-ink-100 dark:hover:bg-ink-800"
              aria-label="Sign out"
            ><LogOut className="w-4 h-4" /></button>
          </div>
        </div>
      </aside>

      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 bg-black/30 z-30" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Open-Tabs Drawer (mobile, right side) */}
      <aside
        className={cn(
          "md:hidden fixed inset-y-0 right-0 z-40 w-72 bg-white dark:bg-ink-900 border-l border-ink-200 dark:border-ink-800 transition-transform safe-top safe-bottom flex flex-col",
          tabsDrawerOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
        <div className="h-14 px-4 flex items-center justify-between border-b border-ink-200 dark:border-ink-800">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-brand" />
            <span className="text-[11px] uppercase tracking-[0.18em] text-ink-500">Offene Tabs</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-100 dark:bg-ink-800 text-ink-500">{openSessions.length}</span>
          </div>
          <button
            onClick={() => setTabsDrawerOpen(false)}
            className="p-2 rounded-lg hover:bg-ink-100 dark:hover:bg-ink-800"
            aria-label="Close"
          ><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-3 scrollbar-thin">
          {openSessions.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-ink-400">Keine offenen Tabs</div>
          )}
          <ul className="space-y-0.5">
            {openSessions.map((s) => (
              <li key={s.id}>
                <div
                  onClick={() => { setActiveId(s.id); setTabsDrawerOpen(false); }}
                  className={cn(
                    "group cursor-pointer w-full px-3 py-2 rounded-lg text-sm flex items-center gap-2",
                    activeId === s.id
                      ? "bg-ink-100 dark:bg-ink-800 text-ink-900 dark:text-ink-50"
                      : "hover:bg-ink-100/60 dark:hover:bg-ink-800/60 text-ink-600 dark:text-ink-400"
                  )}
                >
                  {(s.status === "streaming" || s.status === "connecting") && (
                    <span className="h-1.5 w-1.5 rounded-full bg-brand animate-pulse shrink-0" />
                  )}
                  {s.status === "error" && (
                    <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
                  )}
                  <span className="flex-1 truncate">{s.title}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); closeTab(s.id); }}
                    className="p-1 rounded hover:bg-ink-200 dark:hover:bg-ink-700"
                    aria-label="Close tab"
                  ><X className="w-3.5 h-3.5" /></button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {tabsDrawerOpen && (
        <div className="md:hidden fixed inset-0 bg-black/30 z-30" onClick={() => setTabsDrawerOpen(false)} />
      )}

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Chrome-style tab bar — desktop only */}
        <div className="hidden md:flex h-10 items-end gap-0.5 pt-1.5 px-2 border-b border-ink-200 dark:border-ink-800 bg-ink-100/60 dark:bg-ink-950/60 overflow-x-auto scrollbar-none">
          {openSessions.map((s) => {
            const isActive = activeId === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setActiveId(s.id)}
                className={cn(
                  "group relative shrink-0 max-w-[200px] h-9 pl-3 pr-1.5 rounded-t-lg flex items-center gap-2 text-[12px] transition border border-b-0",
                  isActive
                    ? "bg-white dark:bg-ink-900 border-ink-200 dark:border-ink-800 text-ink-900 dark:text-ink-50 font-medium z-10"
                    : "bg-transparent border-transparent text-ink-500 hover:text-ink-800 dark:hover:text-ink-200 hover:bg-white/50 dark:hover:bg-ink-900/40",
                )}
              >
                {(s.status === "streaming" || s.status === "connecting") ? (
                  <span className="h-1.5 w-1.5 rounded-full bg-brand animate-pulse shrink-0" />
                ) : s.status === "error" ? (
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-ink-300 dark:bg-ink-600 shrink-0" />
                )}
                <span className="flex-1 truncate">{s.title}</span>
                <span
                  role="button"
                  aria-label="Close tab"
                  onClick={(e) => { e.stopPropagation(); closeTab(s.id); }}
                  className="opacity-60 hover:opacity-100 p-1 rounded hover:bg-ink-200 dark:hover:bg-ink-700"
                ><X className="w-3 h-3" /></span>
              </button>
            );
          })}
          <button
            onClick={() => newSession("chat")}
            className="shrink-0 h-9 w-9 flex items-center justify-center rounded-lg text-ink-500 hover:text-ink-900 dark:hover:text-ink-50 hover:bg-white/60 dark:hover:bg-ink-900/40 transition"
            title="New chat (⌘T)"
            aria-label="New chat"
          ><Plus className="w-4 h-4" /></button>
        </div>

        <header className="h-12 md:h-12 px-3 md:px-5 border-b border-ink-200 dark:border-ink-800 flex items-center gap-2 md:gap-3 bg-white/80 dark:bg-ink-900/80 backdrop-blur safe-top">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{active?.title || "Neuer Chat"}</div>
            <div className="text-[11px] text-ink-500 flex items-center gap-1.5">
              <span className={cn(
                "h-1.5 w-1.5 rounded-full",
                status === "streaming" ? "bg-brand animate-pulse"
                  : status === "connecting" ? "bg-amber-500 animate-pulse"
                  : status === "error" ? "bg-red-500"
                  : "bg-emerald-500"
              )} />
              <span className="truncate">
                {status === "streaming" ? "Response incoming…"
                  : status === "connecting" ? "Connecting…"
                  : status === "error" ? (statusMsg || "Error")
                  : "Bridge ready"}
              </span>
            </div>
          </div>

          {/* Usage pill */}
          <div
            className="hidden sm:flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-ink-200 dark:border-ink-700 text-[11px] text-ink-600 dark:text-ink-300 font-mono"
            title={
              active?.usage
                ? `${active.usage.turns} turns · in ${active.usage.tokens_in} · out ${active.usage.tokens_out} · cache-read ${active.usage.cache_read} · cache-create ${active.usage.cache_create}`
                : "No usage yet"
            }
          >
            <span>⌘ {fmtTokens((active?.usage?.tokens_in ?? 0) + (active?.usage?.tokens_out ?? 0))}</span>
            <span className="text-ink-300 dark:text-ink-600">·</span>
            <span className={cn(active?.usage && active.usage.cost_usd > 1 ? "text-amber-600 dark:text-amber-400" : "")}>
              {fmtUsd(active?.usage?.cost_usd ?? 0)}
            </span>
          </div>

          {handsFree && (
            <span className="text-[10px] px-2 py-1 rounded-full bg-brand/10 text-brand border border-brand/20">
              Hands-Free
            </span>
          )}
        </header>

        {active?.mode === "terminal" ? (
          <Terminal sid={active.id} cwd={active.cwd ?? null} theme={theme} />
        ) : (
        <>
        <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin">
          <div className="max-w-3xl mx-auto px-4 md:px-8 py-6 space-y-6">
            {(!active || active.messages.length === 0) && (
              <div className="text-center py-16 animate-fade-in">
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-ink-900 dark:bg-ink-50 text-ink-50 dark:text-ink-900 mb-4 text-xl font-mono">⌘</div>
                <h2 className="text-2xl font-semibold tracking-tight">Where do we start?</h2>
                <p className="text-sm text-ink-500 mt-1">Ask Claude — bridge is running on your host.</p>
                <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-2 max-w-md mx-auto text-left">
                  {["What's on for today?", "Summarize my latest git changes", "Show me the recent deploy logs", "Draft a short status update"].map((p) => (
                    <button
                      key={p}
                      onClick={() => send(p)}
                      className="px-3 py-2.5 text-sm text-left rounded-xl bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-800 hover:border-brand/40 hover:bg-ink-50 dark:hover:bg-ink-800 transition"
                    >{p}</button>
                  ))}
                </div>
              </div>
            )}

            {active?.messages.map((m) => (
              <div key={m.id} className={cn("flex gap-3 animate-fade-in", m.role === "user" ? "justify-end" : "justify-start")}>
                {m.role === "assistant" && (
                  <div className="shrink-0 w-7 h-7 rounded-full bg-ink-900 dark:bg-ink-50 text-ink-50 dark:text-ink-900 flex items-center justify-center text-[11px] font-mono">⌘</div>
                )}
                <div className={cn(
                  "max-w-[85%] md:max-w-[75%] rounded-2xl px-4 py-2.5",
                  m.role === "user"
                    ? "bg-brand text-white rounded-br-md"
                    : "bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-800 rounded-bl-md"
                )}>
                  {m.role === "user"
                    ? <div className="whitespace-pre-wrap text-[15px] leading-relaxed">{m.content}</div>
                    : <div className="prose-msg"><Markdown text={m.content || (busy && m.id === wsMap.current.get(active!.id)?.assistantId ? "▍" : "")} /></div>
                  }
                </div>
              </div>
            ))}
          </div>
        </div>

        <div
          className={cn(
            "relative border-t border-ink-200 dark:border-ink-800 bg-white/80 dark:bg-ink-900/80 backdrop-blur safe-bottom transition",
            dragging && "ring-2 ring-brand/40 ring-inset",
          )}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={(e) => { e.preventDefault(); setDragging(false); }}
          onDrop={onDropFiles}
        >
          {dragging && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-brand/5 text-brand text-sm font-medium z-10">
              Datei hier ablegen
            </div>
          )}
          <div className="max-w-3xl mx-auto px-3 md:px-8 py-3">
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {attachments.map((a, i) => (
                  <div
                    key={a.path}
                    className="flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg bg-ink-100 dark:bg-ink-800 border border-ink-200 dark:border-ink-700 text-[11px]"
                  >
                    {a.kind === "image" ? <ImageIcon className="w-3 h-3 text-brand" /> : <FileText className="w-3 h-3 text-ink-500" />}
                    <span className="font-mono truncate max-w-[180px]">{a.name}</span>
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                      className="p-0.5 rounded hover:bg-ink-200 dark:hover:bg-ink-700 text-ink-500"
                      aria-label="Remove attachment"
                    ><X className="w-3 h-3" /></button>
                  </div>
                ))}
                {uploading && <span className="text-[11px] text-ink-400 self-center">Lade hoch…</span>}
              </div>
            )}
            {mentionState && (mentionState.results.length > 0 || mentionState.loading) && (
              <div className="mb-2 rounded-xl border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-900 shadow-lg max-h-[260px] overflow-y-auto scrollbar-thin">
                {mentionState.loading && mentionState.results.length === 0 && (
                  <div className="px-3 py-2 text-[11px] text-ink-400">Suche „{mentionState.query}" …</div>
                )}
                {mentionState.results.map((r, i) => (
                  <button
                    key={r.path}
                    type="button"
                    onClick={() => applyMention(r)}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs",
                      i === mentionState.cursor ? "bg-ink-100 dark:bg-ink-800" : "hover:bg-ink-100 dark:hover:bg-ink-800",
                    )}
                  >
                    {r.kind === "dir" ? <Folder className="w-3.5 h-3.5 text-brand shrink-0" /> : <FileText className="w-3.5 h-3.5 text-ink-400 shrink-0" />}
                    <span className="flex-1 truncate">
                      <span className="font-medium">{r.path.split("/").pop()}</span>
                      <span className="block text-[10px] text-ink-400 font-mono truncate">{r.path}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <form
              onSubmit={(e) => { e.preventDefault(); send(draft); }}
              className="flex items-end gap-2 bg-ink-50 dark:bg-ink-800 rounded-2xl p-2 border border-ink-200 dark:border-ink-700 focus-within:border-brand/40 transition"
            >
              <button
                type="button"
                onPointerDown={micPointerDown}
                onPointerUp={micPointerUp}
                onPointerLeave={micPointerCancel}
                onPointerCancel={micPointerCancel}
                onContextMenu={(e) => e.preventDefault()}
                disabled={transcribing}
                title={recording ? "Tap to stop" : "Tap = dictate · Long-press = hands-free"}
                className={cn(
                  "shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition select-none touch-none",
                  transcribing
                    ? "bg-ink-200 dark:bg-ink-700 text-ink-500"
                    : recording
                      ? (handsFree ? "bg-brand text-white ring-2 ring-brand/40 animate-pulse" : "bg-brand text-white animate-pulse")
                      : "text-ink-500 hover:text-ink-900 dark:hover:text-ink-50 hover:bg-ink-100 dark:hover:bg-ink-700"
                )}
                aria-label={recording ? "Stop recording" : transcribing ? "Transcribing…" : "Voice input"}
              >
                {transcribing ? (
                  <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="9" opacity="0.25" />
                    <path d="M21 12a9 9 0 0 0-9-9" />
                  </svg>
                ) : recording ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
              </button>

              <label
                className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-ink-500 hover:text-ink-900 dark:hover:text-ink-50 hover:bg-ink-100 dark:hover:bg-ink-700 transition cursor-pointer"
                title="Attach file or image"
              >
                <Paperclip className="w-5 h-5" />
                <input
                  type="file"
                  multiple
                  accept="image/*,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const fs = Array.from(e.target.files || []);
                    for (const f of fs) {
                      const kind = f.type.startsWith("image/") ? "image" : "file";
                      void uploadBlob(f, f.name, kind);
                    }
                    e.target.value = "";
                  }}
                />
              </label>

              <textarea
                ref={taRef}
                value={draft}
                onChange={(e) => onDraftChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
                onSelect={(e) => {
                  const t = e.target as HTMLTextAreaElement;
                  if (mentionState) onDraftChange(t.value, t.selectionStart ?? t.value.length);
                }}
                onPaste={onPaste}
                onKeyDown={(e) => {
                  if (mentionState && mentionState.results.length > 0) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setMentionState((prev) => prev ? { ...prev, cursor: Math.min(prev.cursor + 1, prev.results.length - 1) } : prev);
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setMentionState((prev) => prev ? { ...prev, cursor: Math.max(prev.cursor - 1, 0) } : prev);
                      return;
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      const picked = mentionState.results[mentionState.cursor];
                      if (picked) applyMention(picked);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setMentionState(null);
                      return;
                    }
                    if (e.key === "Tab") {
                      e.preventDefault();
                      const picked = mentionState.results[mentionState.cursor];
                      if (picked) applyMention(picked);
                      return;
                    }
                  }
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(draft); }
                }}
                rows={1}
                placeholder={transcribing ? "Transcribing…" : recording ? (handsFree ? "Hands-free — start talking…" : "Listening… (1.5 s silence = send)") : "Message · @ for file · ⌘V for image"}
                className="flex-1 bg-transparent border-0 outline-none resize-none px-2 py-2.5 text-[15px] leading-relaxed max-h-[200px] scrollbar-thin"
              />

              {busy ? (
                <button
                  type="button"
                  onClick={() => stop()}
                  className="shrink-0 w-10 h-10 rounded-xl bg-ink-900 dark:bg-ink-50 text-ink-50 dark:text-ink-900 flex items-center justify-center hover:opacity-90"
                  aria-label="Stop"
                ><Square className="w-4 h-4" /></button>
              ) : (
                <button
                  type="submit"
                  disabled={!draft.trim() && attachments.length === 0}
                  className="shrink-0 w-10 h-10 rounded-xl bg-brand text-white flex items-center justify-center hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition active:scale-95"
                  aria-label="Send"
                ><Send className="w-4 h-4" /></button>
              )}
            </form>
            <div className="hidden md:block text-[10px] text-ink-400 text-center mt-1.5">
              Enter sendet · @ Datei mentionen · Bild paste/drag · Mic = Voice
            </div>
          </div>
        </div>
        </>
        )}

        {/* Bottom nav — mobile only */}
        <nav className="md:hidden relative z-30 flex items-center justify-around border-t border-ink-200 dark:border-ink-800 bg-white dark:bg-ink-900 safe-bottom">
          <button
            onClick={() => setSidebarOpen(true)}
            className="flex flex-col items-center justify-center gap-0.5 py-2 px-4 flex-1 text-ink-500 hover:text-ink-900 dark:hover:text-ink-50 transition active:scale-95"
            aria-label="History"
          >
            <History className="w-5 h-5" />
            <span className="text-[10px]">Verlauf</span>
          </button>
          <button
            onClick={() => newSession("chat")}
            className="-mt-7 w-14 h-14 rounded-full bg-brand text-white flex items-center justify-center shadow-lg shadow-brand/40 ring-4 ring-white dark:ring-ink-900 hover:scale-105 transition active:scale-95"
            aria-label="New chat"
          >
            <Plus className="w-7 h-7" />
          </button>
          <button
            onClick={() => setTabsDrawerOpen(true)}
            className="relative flex flex-col items-center justify-center gap-0.5 py-2 px-4 flex-1 text-ink-500 hover:text-ink-900 dark:hover:text-ink-50 transition active:scale-95"
            aria-label="Open tabs"
          >
            <Layers className="w-5 h-5" />
            <span className="text-[10px]">Tabs</span>
            {openSessions.length > 0 && (
              <span className="absolute top-1 right-2 min-w-[16px] h-[16px] px-1 rounded-full bg-brand text-white text-[9px] font-semibold flex items-center justify-center">
                {openSessions.length}
              </span>
            )}
          </button>
        </nav>
      </main>
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

