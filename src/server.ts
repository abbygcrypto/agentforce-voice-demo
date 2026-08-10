/**
 * ElevenLabs → Claude bridge.
 *
 * ElevenLabs Conversational AI supports a "Custom LLM" that it drives through
 * an OpenAI-compatible Chat Completions endpoint. This server exposes exactly
 * that shape (`POST /v1/chat/completions`) but fulfills each request by calling
 * Claude through the official Anthropic SDK — streaming tokens back so the
 * voice stays low-latency.
 *
 * Personalization: ElevenLabs is configured to append `?customer=<id>` to the
 * custom-LLM URL (or send it as the OpenAI `user` field). We look the prospect
 * up and build their system prompt on the fly.
 */

import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express, { type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, getCustomer, CUSTOMERS } from "./customers.js";
import { getToolsForCustomer, type CustomerTool } from "./tools.js";
import {
  createAgent,
  getSignedUrl,
  listVoices,
  deleteAgent,
  type AgentConfig,
} from "./elevenlabs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Safety cap so a misbehaving tool loop can't run forever mid-call. */
const MAX_TOOL_ROUNDS = 5;

const PORT = Number(process.env.PORT ?? 8787);
const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5";

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const app = express();
app.use(express.json({ limit: "1mb" }));

/* ------------------------------------------------------------------ */
/* Optional shared-passcode gate.                                      */
/* Set APP_PASSCODE to require a password before the demo (and the     */
/* ElevenLabs-backed APIs) can be used. Unset = open (e.g. local dev). */
/* ------------------------------------------------------------------ */
const PASSCODE = process.env.APP_PASSCODE;

function isAuthed(req: Request): boolean {
  if (!PASSCODE) return true;
  const cookie = req.headers.cookie ?? "";
  const match = cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith("demo_auth="));
  return match?.slice("demo_auth=".length) === PASSCODE;
}

// Login endpoint: exchanges the passcode for a session cookie.
app.post("/login", (req: Request, res: Response) => {
  if (!PASSCODE) return res.json({ ok: true });
  if ((req.body?.passcode ?? "") === PASSCODE) {
    // httpOnly so page JS can't read it; 12h lifetime; Lax is fine for same-site.
    res.setHeader(
      "Set-Cookie",
      `demo_auth=${PASSCODE}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`,
    );
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: "Incorrect passcode" });
});

// Gate everything else when a passcode is configured.
app.use((req: Request, res: Response, next) => {
  if (isAuthed(req)) return next();
  // Let the login page and its assets load; block app + APIs otherwise.
  if (req.path === "/login.html" || req.path === "/styles.css") return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "unauthorized" });
  // Serve the login page for any page/asset request.
  return res.sendFile(path.join(__dirname, "..", "public", "login.html"));
});

app.use(express.static(path.join(__dirname, "..", "public")));

/** Minimal shape of the OpenAI chat-completions payload ElevenLabs sends. */
interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
}
interface OpenAIChatRequest {
  messages: OpenAIChatMessage[];
  stream?: boolean;
  user?: string;
  max_tokens?: number;
}

/**
 * Split an incoming OpenAI-style message list into a single Claude system
 * prompt plus the alternating user/assistant turns Claude expects.
 */
function toClaudeMessages(messages: OpenAIChatMessage[]): {
  system: string[];
  turns: Anthropic.MessageParam[];
} {
  const system: string[] = [];
  const turns: Anthropic.MessageParam[] = [];

  for (const m of messages) {
    const text = (m.content ?? "").toString();
    if (m.role === "system") {
      if (text.trim()) system.push(text);
    } else if (m.role === "user" || m.role === "tool") {
      turns.push({ role: "user", content: text });
    } else if (m.role === "assistant") {
      turns.push({ role: "assistant", content: text });
    }
  }
  return { system, turns };
}

/** Resolve which prospect this call belongs to. */
function resolveCustomerId(req: Request, body: OpenAIChatRequest): string | undefined {
  const q = req.query.customer;
  if (typeof q === "string" && q) return q;
  // ElevenLabs can pass metadata through the OpenAI `user` field.
  if (body.user) return body.user;
  return undefined;
}

/** One SSE chunk in OpenAI's streaming format, so ElevenLabs can parse it. */
function sseChunk(delta: string, model: string): string {
  const payload = {
    id: "chatcmpl-claude",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseDone(model: string): string {
  const payload = {
    id: "chatcmpl-claude",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`;
}

/**
 * Execute every tool_use block in an assistant message and return the matching
 * tool_result blocks to feed back to Claude. Runs the prospect's handlers
 * server-side — the caller never sees this, only the eventual spoken reply.
 */
async function runToolCalls(
  content: Anthropic.ContentBlock[],
  tools: CustomerTool[],
): Promise<Anthropic.ToolResultBlockParam[]> {
  const uses = content.filter(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );

  return Promise.all(
    uses.map(async (use): Promise<Anthropic.ToolResultBlockParam> => {
      const tool = tools.find((t) => t.spec.name === use.name);
      try {
        if (!tool) throw new Error(`unknown tool: ${use.name}`);
        const result = await tool.run((use.input ?? {}) as Record<string, unknown>);
        return {
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify(result),
        };
      } catch (err) {
        console.error(`tool ${use.name} failed:`, err);
        return {
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content: JSON.stringify({ error: (err as Error).message }),
        };
      }
    }),
  );
}

app.post("/v1/chat/completions", async (req: Request, res: Response) => {
  const body = req.body as OpenAIChatRequest;
  const customer = getCustomer(resolveCustomerId(req, body));
  const { system: incomingSystem, turns } = toClaudeMessages(body.messages ?? []);

  // Our persona system prompt leads; any system text ElevenLabs injected follows.
  const system = [buildSystemPrompt(customer), ...incomingSystem].join("\n\n");

  const tools = getToolsForCustomer(customer.id);
  const toolSpecs = tools.map((t) => t.spec);
  const wantStream = body.stream !== false; // default to streaming

  // Working transcript for this request; grows as tool rounds happen.
  const messages: Anthropic.MessageParam[] = [...turns];

  try {
    if (wantStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      // Loop: stream a turn; if Claude asked for tools, run them and continue.
      // Only assistant *text* is streamed to ElevenLabs — tool rounds are silent.
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const stream = anthropic.messages.stream({
          model: MODEL,
          max_tokens: body.max_tokens ?? 512,
          thinking: { type: "adaptive" },
          system,
          messages,
          ...(toolSpecs.length ? { tools: toolSpecs } : {}),
        });

        stream.on("text", (delta) => res.write(sseChunk(delta, MODEL)));

        const final = await stream.finalMessage();

        if (final.stop_reason === "tool_use" && round < MAX_TOOL_ROUNDS) {
          const results = await runToolCalls(final.content, tools);
          messages.push({ role: "assistant", content: final.content });
          messages.push({ role: "user", content: results });
          continue; // stream the next turn, which uses the tool results
        }
        break; // produced a spoken reply (or hit the round cap)
      }

      res.write(sseDone(MODEL));
      res.end();
    } else {
      let text = "";
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const msg = await anthropic.messages.create({
          model: MODEL,
          max_tokens: body.max_tokens ?? 512,
          thinking: { type: "adaptive" },
          system,
          messages,
          ...(toolSpecs.length ? { tools: toolSpecs } : {}),
        });

        if (msg.stop_reason === "tool_use" && round < MAX_TOOL_ROUNDS) {
          const results = await runToolCalls(msg.content, tools);
          messages.push({ role: "assistant", content: msg.content });
          messages.push({ role: "user", content: results });
          continue;
        }

        text = msg.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        break;
      }

      res.json({
        id: "chatcmpl-claude",
        object: "chat.completion",
        model: MODEL,
        choices: [
          { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
        ],
      });
    }
  } catch (err) {
    console.error("Claude request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: "upstream LLM error" } });
    } else {
      res.end();
    }
  }
});

/** Handy for demos: fetch a prospect's opening line for the ElevenLabs "first message". */
app.get("/greeting", (req: Request, res: Response) => {
  const customer = getCustomer(
    typeof req.query.customer === "string" ? req.query.customer : undefined,
  );
  res.json({ customer: customer.id, greeting: customer.greeting, voiceId: customer.elevenLabsVoiceId });
});

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    model: MODEL,
    voiceReady: Boolean(process.env.ELEVENLABS_API_KEY),
    claudeReady: Boolean(process.env.ANTHROPIC_API_KEY),
  }),
);

/* ------------------------------------------------------------------ */
/* Voice demo API (ElevenLabs Conversational AI)                       */
/* ------------------------------------------------------------------ */

/** Seed the UI with the built-in prospect profiles. */
app.get("/api/customers", (_req, res) => {
  const seeds = Object.values(CUSTOMERS).map((c) => ({
    id: c.id,
    industry: c.industry,
    companyName: c.companyName,
    businessDescription: c.businessDescription,
    agentName: c.agentName,
    greeting: c.greeting,
    personaStyle: c.personaStyle,
    knowledgeBase: c.knowledgeBase,
    guardrails: c.guardrails,
    voiceId: c.elevenLabsVoiceId,
    systemPrompt: buildSystemPrompt(c),
  }));
  res.json({ customers: seeds });
});

/** List the account's voices for the customization dropdown. */
app.get("/api/voices", async (_req, res) => {
  try {
    res.json({ voices: await listVoices() });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: (err as Error).message });
  }
});

/** Shape the browser posts to start a call. */
interface SessionRequest {
  companyName: string;
  systemPrompt: string;
  firstMessage: string;
  voiceId: string;
  /** If true and a Claude key is present, route the LLM through our bridge. */
  useClaude?: boolean;
}

/**
 * Create a fresh ConvAI agent for this customization and return a signed URL
 * plus the agent id (so the browser can ask us to clean it up afterwards).
 */
app.post("/api/session", async (req: Request, res: Response) => {
  const body = req.body as SessionRequest;
  if (!body?.systemPrompt || !body?.voiceId) {
    return res.status(400).json({ error: "systemPrompt and voiceId are required" });
  }

  // Only wire the Claude bridge if the caller asked AND we have a key AND we
  // know our public URL (ElevenLabs must be able to reach the bridge).
  const publicBase = process.env.PUBLIC_BASE_URL;
  const useClaude = Boolean(body.useClaude && process.env.ANTHROPIC_API_KEY && publicBase);

  const cfg: AgentConfig = {
    companyName: body.companyName || "Demo Company",
    systemPrompt: body.systemPrompt,
    firstMessage: body.firstMessage || "Hello, how can I help?",
    voiceId: body.voiceId,
    customLlmUrl: useClaude ? `${publicBase}/v1/chat/completions` : undefined,
  };

  try {
    const agentId = await createAgent(cfg);
    const signedUrl = await getSignedUrl(agentId);
    res.json({ agentId, signedUrl, llm: useClaude ? "claude" : "elevenlabs-builtin" });
  } catch (err) {
    console.error("session create failed:", err);
    res.status(502).json({ error: (err as Error).message });
  }
});

/** Tear down a demo agent when the call ends. */
app.post("/api/session/:agentId/end", async (req: Request, res: Response) => {
  await deleteAgent(req.params.agentId);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`ivr-voice-agent-demo listening on http://localhost:${PORT}`);
  console.log(`  phone demo UI       : http://localhost:${PORT}/`);
  console.log(`  custom-LLM endpoint : POST /v1/chat/completions`);
  console.log(`  model               : ${MODEL}`);
  console.log(`  voice (ElevenLabs)  : ${process.env.ELEVENLABS_API_KEY ? "ready" : "no key"}`);
  console.log(`  brain  (Claude)     : ${process.env.ANTHROPIC_API_KEY ? "ready" : "no key — using ElevenLabs built-in LLM"}`);
});
