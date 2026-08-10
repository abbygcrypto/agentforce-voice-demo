# IVR Voice Agent Demo — ElevenLabs + Claude

A voice agent that replaces a traditional touch-tone IVR ("press 1 for billing…")
with a natural conversation. **ElevenLabs** handles the voice (speech-to-text,
turn-taking, text-to-speech); **Claude** is the brain. The agent is
**personalized per prospect** — swap one URL parameter and it becomes a
different company's assistant, with its own persona, voice, facts, and guardrails.

## How it fits together

```
   Caller  ──telephony──▶  ElevenLabs Conversational AI  ──"Custom LLM"──▶  THIS SERVER  ──Anthropic SDK──▶  Claude
            (voice)         (STT · turn-taking · TTS)      OpenAI /chat        (persona +          (reasoning)
                                                           /completions        streaming)
```

ElevenLabs lets you point an agent at a **Custom LLM** that speaks the
OpenAI Chat Completions wire format. This server exposes exactly that
(`POST /v1/chat/completions`) but answers every request with Claude via the
official `@anthropic-ai/sdk`, streaming tokens back so speech stays low-latency.

## Personalization model

Each prospect is a `CustomerProfile` in `src/customers.ts` (company identity,
greeting, persona/tone, knowledge base, guardrails, ElevenLabs voice id). At
call time we select one by `?customer=<id>` on the custom-LLM URL and build
Claude's system prompt from it. In production you'd hydrate these fields from a
CRM/knowledge base keyed on the dialed number or account id instead of a static
map. Two sample prospects ship in the repo: `northwind` (a utility) and
`meridian` (a healthcare provider).

## The phone demo app

Open **http://localhost:8787/** for a browser app styled like a mobile phone
agent (AgentForce look). A side panel lets you customize the agent live for a
prospect — company name, greeting, persona/system prompt, and voice — then press
**Call** to talk to it in the browser. Each call spins up a fresh ElevenLabs
Conversational AI agent with those settings and connects over a signed URL (your
API key never reaches the browser). Two starting profiles (Northwind, Meridian)
are preloaded; edit any field to make it your prospect's.

**Which brain answers?** By default the agent uses ElevenLabs' built-in LLM, so
the demo works with only an ElevenLabs key. Tick **Use Claude** (enabled once
`ANTHROPIC_API_KEY` and `PUBLIC_BASE_URL` are set) to route the agent's LLM
through the Claude bridge instead — see below.

## Run it

```bash
cd ivr-voice-agent-demo
npm install
cp .env.example .env      # add ELEVENLABS_API_KEY (required for voice)
npm run dev               # then open http://localhost:8787/
```

Smoke-test the brain without any telephony:

```bash
# Non-streaming, as the Northwind utility agent
curl -s http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"stream":false,"messages":[{"role":"user","content":"my power is out"}]}?customer=northwind'

# Personalized as the healthcare agent (note the ?customer= param)
curl -s 'http://localhost:8787/v1/chat/completions?customer=meridian' \
  -H 'content-type: application/json' \
  -d '{"stream":false,"messages":[{"role":"user","content":"I need to move my appointment"}]}'
```

## Wire it to ElevenLabs

1. Expose this server publicly (e.g. `ngrok http 8787`) so ElevenLabs can reach it.
2. In the ElevenLabs dashboard, create a **Conversational AI agent**.
3. Under the agent's **LLM** setting choose **Custom LLM** and set the URL to:
   `https://<your-tunnel>/v1/chat/completions?customer=northwind`
   (change the `customer` value to demo a different prospect).
4. Set the agent's **First message** to that prospect's greeting — fetch it from
   `GET /greeting?customer=northwind`, and set the **Voice** to the returned `voiceId`.
5. Call the agent and talk to it. To demo a second prospect, duplicate the agent
   and change `?customer=` and the voice — same backend, different company.

## Files

| File | Purpose |
|------|---------|
| `src/server.ts` | OpenAI-compatible endpoint → Claude, streaming + server-side tool loop |
| `src/customers.ts` | Per-prospect profiles + system-prompt builder |
| `src/tools.ts` | Per-prospect tools (the actions the agent can take) |
| `.env.example` | Required `ANTHROPIC_API_KEY` and optional overrides |

## Tools — the agent takes real actions

The agent doesn't just talk; it calls tools. Because ElevenLabs only wants a
final spoken reply, the **entire Claude tool loop runs inside one
`/v1/chat/completions` request**: Claude requests a tool → we execute the
handler server-side → feed the result back → repeat until Claude produces
speech (capped at `MAX_TOOL_ROUNDS`). Tool rounds are silent; only assistant
*text* is streamed out to the voice.

Tools are per-prospect (`src/tools.ts`):

| Prospect | Tools |
|----------|-------|
| `northwind` | `get_outage_status(zip)`, `lookup_account_balance(lastFour)` |
| `meridian` | `find_clinic(clinic)`, `reschedule_appointment(clinic, newDateTime)` |

The data is mocked so the demo runs with no external systems. Each handler body
is the seam where you'd call the prospect's real billing / outage / scheduling
API — nothing else changes.

Try it:

```bash
# Northwind will call get_outage_status for ZIP 94103 and speak the result
curl -s 'http://localhost:8787/v1/chat/completions?customer=northwind' \
  -H 'content-type: application/json' \
  -d '{"stream":false,"messages":[{"role":"user","content":"is the power out in 94103?"}]}'
```

## Notes

- Model defaults to `claude-opus-5` with adaptive thinking; override with `CLAUDE_MODEL`.
- Add a tool by appending to the prospect's array in `src/tools.ts` — the spec
  is a standard Anthropic tool schema and `run()` returns any JSON-able value.
