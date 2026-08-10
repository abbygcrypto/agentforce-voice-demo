/**
 * ElevenLabs Conversational AI helpers.
 *
 * The API key lives ONLY here (server-side). The browser never sees it — it
 * gets a short-lived signed URL to open the voice WebSocket.
 *
 * Flow for a demo call:
 *   1. Front-end posts the customization (company, persona, greeting, voice).
 *   2. We create a fresh ConvAI agent with that config.
 *   3. We mint a signed URL for that agent and return it.
 *   4. The browser opens the mic session with @elevenlabs/client.
 *
 * The agent's LLM is currently ElevenLabs' built-in model so the demo works
 * without an Anthropic key. To route thinking through Claude instead, set
 * `customLlmUrl` — it configures the agent's "Custom LLM" to point at our
 * /v1/chat/completions bridge.
 */

const API = "https://api.elevenlabs.io/v1";

function apiKey(): string {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new Error("ELEVENLABS_API_KEY is not set");
  return k;
}

export interface AgentConfig {
  companyName: string;
  systemPrompt: string;
  firstMessage: string;
  voiceId: string;
  /** If set, route the agent's LLM through this OpenAI-compatible URL (Claude bridge). */
  customLlmUrl?: string;
}

export interface VoiceSummary {
  voiceId: string;
  name: string;
}

/** List the voices available in the connected account. */
export async function listVoices(): Promise<VoiceSummary[]> {
  const res = await fetch(`${API}/voices`, {
    headers: { "xi-api-key": apiKey() },
  });
  if (!res.ok) throw new Error(`listVoices failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { voices: Array<{ voice_id: string; name: string }> };
  return data.voices.map((v) => ({ voiceId: v.voice_id, name: v.name }));
}

/** Create a Conversational AI agent from a customization payload. Returns its id. */
export async function createAgent(cfg: AgentConfig): Promise<string> {
  const promptBlock: Record<string, unknown> = { prompt: cfg.systemPrompt };

  if (cfg.customLlmUrl) {
    // Route the agent through our Claude bridge instead of the built-in LLM.
    promptBlock.llm = "custom-llm";
    promptBlock.custom_llm = { url: cfg.customLlmUrl };
  }

  const body = {
    name: `${cfg.companyName} — IVR demo`,
    conversation_config: {
      agent: {
        first_message: cfg.firstMessage,
        language: "en",
        prompt: promptBlock,
      },
      tts: {
        voice_id: cfg.voiceId,
        // ElevenLabs requires turbo/flash v2 for English ConvAI agents.
        model_id: "eleven_turbo_v2",
      },
      conversation: {
        max_duration_seconds: 600,
      },
    },
  };

  const res = await fetch(`${API}/convai/agents/create`, {
    method: "POST",
    headers: { "xi-api-key": apiKey(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`createAgent failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { agent_id: string };
  return data.agent_id;
}

/** Mint a short-lived signed URL the browser uses to open the voice session. */
export async function getSignedUrl(agentId: string): Promise<string> {
  const res = await fetch(
    `${API}/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
    { headers: { "xi-api-key": apiKey() } },
  );
  if (!res.ok) throw new Error(`getSignedUrl failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { signed_url: string };
  return data.signed_url;
}

/** Best-effort cleanup so demo agents don't pile up in the account. */
export async function deleteAgent(agentId: string): Promise<void> {
  await fetch(`${API}/convai/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
    headers: { "xi-api-key": apiKey() },
  }).catch(() => {});
}
