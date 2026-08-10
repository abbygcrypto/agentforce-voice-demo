# Deploying the Agentforce Voice Demo for your team

Goal: a single HTTPS URL your colleagues can open on any laptop. The server
holds the ElevenLabs key (never the browser), and a shared passcode keeps the
link from being used by anyone who stumbles on it.

> **Why hosting, not just a file:** the ElevenLabs key must stay server-side,
> and browsers only allow microphone access over HTTPS. A host gives you both.

## What you'll set

| Env var | Required? | Purpose |
|---|---|---|
| `ELEVENLABS_API_KEY` | ✅ yes | Powers the voice layer. Starts `sk_`. |
| `APP_PASSCODE` | 🔒 strongly recommended | One shared password gating the whole app. Unset = open to anyone with the link. |
| `ANTHROPIC_API_KEY` | optional | Enables Claude as the brain. Starts `sk-ant-`. |
| `PUBLIC_BASE_URL` | optional | Your deployed URL (e.g. `https://agentforce-voice-demo.onrender.com`). Needed only to turn on the Claude brain. |

## Option A — Render (recommended, has a free tier)

1. Push this repo to GitHub (see "Publish to GitHub" below).
2. Go to <https://render.com> → **New** → **Blueprint** → connect the repo.
   Render reads `render.yaml` and creates the web service.
3. In the service's **Environment** tab, set the secret values:
   - `ELEVENLABS_API_KEY` = your `sk_...` key
   - `APP_PASSCODE` = a password to share with the team (e.g. `astro-2026`)
   - *(optional)* `ANTHROPIC_API_KEY`, and `PUBLIC_BASE_URL` = the URL Render gives you
4. Deploy. You'll get a URL like `https://agentforce-voice-demo.onrender.com`.
5. Share the URL + passcode with your team. Done.

> Free-tier note: Render spins the service down after idle time, so the first
> visit after a quiet period takes ~30–60s to wake. Fine for demos; upgrade the
> plan if you want it always-on.

## Option B — Railway / Fly / any Node host

Any host that runs a Node web service works. Configure:
- **Build:** `npm install`
- **Start:** `npm start`
- **Env vars:** the table above.
- Node 20+.

## Publish to GitHub

```bash
cd ~/ivr-voice-agent-demo
git init
git add -A
git commit -m "Agentforce Voice Demo"
# create an empty repo on github.com first, then:
git remote add origin https://github.com/<you>/agentforce-voice-demo.git
git branch -M main
git push -u origin main
```

`.env` is gitignored, so your keys never get committed — you set them in the
host's dashboard instead.

## Cost & safety reminders

- **Usage bills to whoever owns the ElevenLabs key.** Every call consumes your
  character quota. The passcode limits this to people you share it with.
- **Rotate the key** if it ever leaks; update it in the host dashboard.
- The passcode is a light gate (one shared secret over HTTPS), appropriate for
  an internal demo — not a substitute for real per-user auth.
