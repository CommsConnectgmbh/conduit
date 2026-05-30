# Conduit

A private chat PWA that lets you talk to your own `claude` Code CLI from anywhere — phone, laptop, browser — with full skills, memory, and MCP access intact. Open it from a coffee shop, ask it to deploy your repo, see logs streamed back. Voice in, text out.

```
[your phone or browser]
        │ HTTPS
        ▼
  Vercel (Next.js 14 PWA)        ← this repo: web/
        │ WSS (signed JWT)
        ▼
  Cloudflare Tunnel
        │
        ▼
  your Mac / server :8787        ← this repo: bridge/
        │ stdio (stream-json)
        ▼
  claude CLI  (your install, your subscription, your memory)
```

The bridge spawns `claude --print --output-format stream-json` per chat session and pipes the streaming output to the browser over WebSocket. Sessions are resumed via `--resume <id>` so context survives reconnects.

## What you get

- Send text or voice prompts to Claude from anywhere
- Local Whisper-server transcription
- Paste / drag-drop images and PDFs, Claude reads them
- `@`-mention any file under your project roots with fuzzy autocomplete
- Multiple concurrent chat sessions, persisted in SQLite, Chrome-style tab bar
- Mobile bottom-nav with history + new-chat + open-tabs
- 8-digit OTP login via Resend, allowlist-gated
- PWA installable on iOS / Android / desktop — full-screen, no browser chrome
- Optional native macOS multi-tab wrapper (`mac/`)

## What you provide

- A `claude` Code CLI install on a machine that stays online (Mac mini, Linux box, whatever)
- A Cloudflare account (free tier) for the tunnel
- A Vercel account (free tier) for the web side
- A Resend account (free tier — 100 mails/day) for OTP delivery
- A domain to host it on
- ~30 min of one-time setup

The Anthropic subscription / token / memory all live on your machine. This project never proxies through anyone else's servers.

## Want Claude to set this up for you?

If you have Claude Code installed locally, paste this into a new conversation:

> Clone https://github.com/CommsConnectgmbh/conduit into /tmp, read its `CLAUDE.md`, and walk me through the setup interactively. Ask me for the values it needs (domain, Cloudflare account, Vercel account, Resend key, allowlist email) and create everything for me.

Claude reads `CLAUDE.md`, asks the few questions it needs, runs the install scripts, and sets up DNS + tunnel + Vercel project + launchd agent. ~10 min end-to-end if your accounts are ready.

## Repo layout

| Folder      | What it is                                                 |
|-------------|------------------------------------------------------------|
| `web/`      | Next.js 14 PWA — the UI you actually use                   |
| `bridge/`   | Node WebSocket service that spawns `claude` on your Mac    |
| `mac/`      | Optional native macOS wrapper (SwiftUI + WKWebView tabs)   |
| `infra/`    | launchd plist templates                                    |
| `scripts/`  | Install + deploy helpers                                   |

## Manual setup

### 1. Local bridge

```bash
git clone https://github.com/CommsConnectgmbh/conduit.git
cd conduit/bridge
npm install
cp .env.example .env.local
$EDITOR .env.local                # set BRIDGE_SECRET, CLAUDE_BIN, CLAUDE_CWD
node src/server.mjs               # smoke test
curl http://127.0.0.1:8787/healthz # should say {"ok":true,"claude":true,...}
```

Install as launchd agent (macOS):
```bash
bash scripts/install-launchd.sh
```

On Linux use systemd-user instead.

### 2. Cloudflare tunnel

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create conduit
cloudflared tunnel route dns conduit bridge.your-domain.com
```

`~/.cloudflared/config.yml`:
```yaml
tunnel: <your-tunnel-uuid>
credentials-file: /Users/you/.cloudflared/<uuid>.json
ingress:
  - hostname: bridge.your-domain.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

```bash
cloudflared service install
```

### 3. Vercel deploy (web)

```bash
cd web
cp .env.example .env.local
$EDITOR .env.local                # AUTH_SECRET, ALLOWED_EMAILS, RESEND_API_KEY, ...
npm install
npm run build                     # local sanity check
npx vercel link
npx vercel env add AUTH_SECRET    # repeat for each var
npx vercel deploy --prod
```

Add your custom domain in the Vercel project settings → point a CNAME at `cname.vercel-dns.com`.

### 4. Login

Open `https://your-domain.com`, enter an allowlisted email, type the 8-digit code from your inbox.

### 5. Optional: native Mac app

```bash
cd mac
$EDITOR Sources/ConduitMacApp/TabModel.swift   # set URL to your domain
bash scripts/install.sh                        # builds + installs to /Applications/Conduit.app
```

## Configuration knobs worth knowing

- **`ALLOWED_EMAILS`** — comma-separated, lowercased. Anyone else is silently rejected. **Security note:** the bridge is single-tenant per host and runs `claude` with `--permission-mode bypassPermissions`. Every allowlisted email therefore gets the *same* trust level — effectively full access to whatever is under `FILE_SEARCH_ROOTS`/`CLAUDE_CWD`. Only add emails you'd trust with that host.
- **`CLAUDE_CWD`** — the working directory `claude` spawns in. Point it at your code root so skills/memory/MCPs load.
- **`CLAUDE_MODEL`** — passed as `--model`. Use any current Anthropic model id.
- **`FILE_SEARCH_ROOTS`** — colon-separated roots for `@`-mentions and per-session cwd. Defaults to `CLAUDE_CWD`. **Scope this to concrete project roots — never `homedir()`** — so allowlisted users cannot enumerate the whole filesystem. Secret files (`.env*`, `*.pem`, `*.key`, `*.p8`, `id_rsa`…) are always excluded from search/mentions even inside these roots, and per-session `cwd` is rejected if it falls outside them.
- **`BRIDGE_HOST`** — must stay `127.0.0.1`. The bridge refuses to start on `0.0.0.0`.
- **`BRIDGE_ALLOWED_HOSTS`** — optional comma-separated `Host` allowlist (DNS-rebinding protection); loopback is always allowed.
- **Whisper server** — for voice in, you need `whisper-server` (from whisper.cpp) running on `:8088`. See [whisper.cpp docs](https://github.com/ggerganov/whisper.cpp).

## Stack

Next.js 14 App Router, Node 20+ (built-in `node:sqlite`), `ws`, `node-pty`, Jose (JWT), Tailwind, Resend, Cloudflare Tunnel.

## Security model

- TLS everywhere — Cloudflare terminates HTTPS at the tunnel edge; bridge binds 127.0.0.1 only.
- All WS upgrades require a fresh JWT signed by `BRIDGE_SECRET` (issued by web on demand, 5 min TTL).
- Allowlist on the web side — no public signup.
- `claude` is launched with whatever permissions you give it. The bridge does not sandbox. If you set `--permission-mode bypassPermissions` in `bridge/src/server.mjs`, anyone with a valid login can run shell commands on your machine. That's the point of the project — but treat your allowlist accordingly.

## About the author

Built by **Rainer Roloff** — founder of [Comms Connect](https://www.comms-connect.de), a German telco/IT brokerage, and a handful of side projects that all run on top of Claude Code. Conduit is the daily driver I use to keep talking to my own setup from the phone.

More on [rainerroloff.de](https://rainerroloff.de) · [GitHub](https://github.com/CommsConnectgmbh)

## License

MIT — see `LICENSE`. No warranty. No support promises. Pull requests welcome.
