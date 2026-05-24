# Setup instructions for Claude Code

This file is for you, Claude. The user has asked you to set up Conduit on their machine. Follow these steps in order. Ask the user only the questions explicitly marked **ASK**. Everything else you can figure out from their system.

## What you're setting up

A two-process system:
1. A Node bridge running locally on the user's Mac / Linux box, spawning `claude` CLI per chat session, listening on `127.0.0.1:8787`.
2. A Next.js PWA on Vercel that talks to the bridge through a Cloudflare Tunnel.

After setup the user opens `https://<their-domain>` on any device, gets an 8-digit code by mail, and chats with their own Claude.

## Preflight — check before asking the user anything

```bash
which claude                      # must exist; if not, abort and tell user to install Claude Code first
which node && node -v             # need 20+
which cloudflared || brew install cloudflared
which gh && gh auth status        # nice to have for repo work
which vercel || npm i -g vercel
```

If `claude` is missing, stop. Tell the user to install Claude Code first (https://docs.claude.com/en/docs/claude-code/quickstart).

## Questions to ASK the user

Ask these as a single bundle, not one at a time:

1. **Domain you'll host Conduit on** (e.g. `conduit.example.com`) — must be on a Cloudflare-managed zone.
2. **Email allowlist** — comma-separated emails that may log in.
3. **Resend API key** — sign up at https://resend.com, verify the sending domain, generate a key. Format `re_...`.
4. **Vercel team/scope** (optional — `vercel link` will prompt anyway).

You can resolve the rest yourself.

## Steps

### 1. Clone

```bash
cd /tmp
git clone https://github.com/CommsConnectgmbh/conduit.git
cd conduit
```

### 2. Bridge

```bash
cd bridge
npm install
cp .env.example .env.local
```

Edit `.env.local`:
- `BRIDGE_SECRET` — generate with `openssl rand -hex 32`
- `CLAUDE_BIN` — output of `which claude`
- `CLAUDE_CWD` — pick a sensible default. If the user has a `~/code` or similar root, use it; otherwise their home directory.
- `LOG_DIR` — `$HOME/Library/Logs/conduit-bridge` on macOS, `$HOME/.local/state/conduit-bridge` on Linux

Smoke test:
```bash
node src/server.mjs &              # background it briefly
sleep 2
curl -s http://127.0.0.1:8787/healthz
kill %1
```

Expected output: `{"ok":true,"claude":true,...}`.

### 3. launchd (macOS) — install as background agent

```bash
cd ..
bash scripts/install-launchd.sh
```

That renders the plist template with the actual install path and bootstraps it. Verify with `launchctl list | grep conduit`.

### 4. Cloudflare tunnel

```bash
cloudflared tunnel login            # opens browser — user authorizes
cloudflared tunnel create conduit
TUNNEL_ID=$(cloudflared tunnel list | awk '/conduit/ {print $1}')
cloudflared tunnel route dns conduit bridge.<their-domain>
```

Write `~/.cloudflared/config.yml`:
```yaml
tunnel: $TUNNEL_ID
credentials-file: /Users/<user>/.cloudflared/$TUNNEL_ID.json
ingress:
  - hostname: bridge.<their-domain>
    service: http://127.0.0.1:8787
    originRequest:
      connectTimeout: 30s
  - service: http_status:404
```

Install as a service:
```bash
sudo cloudflared service install
```

Or for user-level launchd on macOS, write a plist that runs `cloudflared tunnel run conduit`.

### 5. Web — Vercel deploy

```bash
cd web
npm install
cp .env.example .env.local
```

Edit `.env.local`:
- `AUTH_SECRET` — `openssl rand -hex 32`
- `BRIDGE_SECRET` — same value as in `bridge/.env.local`
- `RESEND_API_KEY` — from the user
- `ALLOWED_EMAILS` — from the user
- `APP_URL` = `https://<their-domain>`
- `BRIDGE_URL` = `wss://bridge.<their-domain>`
- `FROM_EMAIL` = `conduit@<verified-sending-domain>`
- `FROM_NAME` = `Conduit`

Then:
```bash
npm run build                       # sanity check
npx vercel link                     # answer prompts
# Push all env vars to Vercel production:
for k in AUTH_SECRET BRIDGE_SECRET RESEND_API_KEY ALLOWED_EMAILS APP_URL BRIDGE_URL FROM_EMAIL FROM_NAME; do
  v=$(grep "^$k=" .env.local | cut -d= -f2-)
  echo "$v" | npx vercel env add "$k" production
done
npx vercel deploy --prod
```

### 6. DNS for the web side

In Cloudflare DNS for `<their-domain>`:
- Add CNAME for the apex (or `conduit` subdomain) → `cname.vercel-dns.com`, **not** proxied.
- The `bridge` subdomain is already pointing at the tunnel from step 4.

In Vercel project settings: add `<their-domain>` as the production domain.

### 7. Verify

```bash
curl -s https://bridge.<their-domain>/healthz       # bridge reachable through tunnel
curl -sI https://<their-domain>/login               # 200 from Vercel
```

Then tell the user: open `https://<their-domain>`, enter their allowlisted email, type the 8-digit code from their inbox.

### 8. Optional: native Mac wrapper

```bash
cd mac
sed -i '' "s|conduit.example.com|<their-domain>|g" Sources/ConduitMacApp/TabModel.swift
bash scripts/install.sh
```

Installs `/Applications/Conduit.app` and opens it.

## Things to watch for

- **iOS Safari + Service Workers** — `web/public/sw.js` deliberately self-unregisters to avoid cache poisoning across deploys. Don't add a real SW unless you know what you're doing.
- **Resend domain verification** — `FROM_EMAIL` must be on a domain verified in the user's Resend account, otherwise mails silently fail.
- **JWT issuer is hard-coded to `conduit`** in `web/lib/auth.ts`, `web/lib/otp.ts`, `web/lib/rate-limit.ts`, and `bridge/src/server.mjs`. Both halves must match — don't change one without the other.
- **Cookies** are `conduit_session`, `conduit_pending`, `conduit_rl`. Same caveat — must match between `web/lib/config.ts` and `web/middleware.ts`.
- **`claude` permission mode** — bridge uses `--permission-mode bypassPermissions` by default (see `bridge/src/server.mjs` near `spawn_claude`). Warn the user: anyone in their allowlist can run arbitrary commands on this machine.

## When done

Report back to the user:
- Live URL
- Allowlisted emails
- How to add more emails later (edit Vercel env `ALLOWED_EMAILS`, redeploy)
- Where logs live (`~/Library/Logs/conduit-bridge/` on macOS)
- Command to restart bridge if needed: `launchctl kickstart -k gui/$(id -u)/de.example.conduit-bridge`
