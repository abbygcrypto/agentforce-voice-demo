// Phone-demo front-end. Loads the ElevenLabs browser client from a CDN ESM
// build (no bundler needed), fetches customization seeds + voices from our
// server, and drives a live voice session.
import { Conversation } from "https://esm.sh/@elevenlabs/client@0.10.0";

const $ = (id) => document.getElementById(id);

const els = {
  profile: $("profile"),
  companyName: $("companyName"),
  firstMessage: $("firstMessage"),
  voiceId: $("voiceId"),
  systemPrompt: $("systemPrompt"),
  useClaude: $("useClaude"),
  claudeNote: $("claudeNote"),
  callBtn: $("callBtn"),
  hangBtn: $("hangBtn"),
  callState: $("callState"),
  timer: $("timer"),
  transcript: $("transcript"),
  orb: $("orb"),
  screenCompany: $("screenCompany"),
  screenSub: $("screenSub"),
};

// Per-industry color theme: [accent, accent-2, screen gradient stops].
const THEMES = {
  communications: { a: "#00b4d8", a2: "#0077b6", s: ["#083b57", "#052a44", "#03192e"] },
  energy:         { a: "#ffb703", a2: "#fb8500", s: ["#4a3410", "#2e2109", "#1a1305"] },
  construction:   { a: "#f4a261", a2: "#e76f51", s: ["#4a2f1e", "#2f1e14", "#1c120c"] },
  financial:      { a: "#2a9d8f", a2: "#1d6f66", s: ["#0e3b39", "#082826", "#041a19"] },
  healthcare:     { a: "#ef476f", a2: "#c81d54", s: ["#4a1327", "#320d1b", "#1e0710"] },
  hightech:       { a: "#4361ee", a2: "#7b2ff7", s: ["#1b2350", "#131a3c", "#0a0f26"] },
  legal:          { a: "#8d99ae", a2: "#4a5568", s: ["#2b3240", "#1e232e", "#12151c"] },
  logistics:      { a: "#ff8c42", a2: "#d65a1f", s: ["#4a2c14", "#301c0d", "#1c1008"] },
  manufacturing:  { a: "#6c757d", a2: "#495057", s: ["#2d3238", "#202428", "#131619"] },
  media:          { a: "#e63946", a2: "#9d0208", s: ["#450f14", "#2e0a0e", "#1b0508"] },
  nonprofit:      { a: "#52b788", a2: "#2d6a4f", s: ["#123d2d", "#0c2a20", "#061a13"] },
  proservices:    { a: "#3a86ff", a2: "#1b4dcc", s: ["#132d55", "#0d1f3c", "#071224"] },
  publicsector:   { a: "#457b9d", a2: "#1d3557", s: ["#14304a", "#0e2233", "#08141f"] },
  retail:         { a: "#ff5d8f", a2: "#c9184a", s: ["#4a1428", "#320d1b", "#1e0710"] },
};

let profiles = [];
let conversation = null;
let currentAgentId = null;
let timerHandle = null;
let seconds = 0;

// ---- boot: profiles, voices ------------------------------------------------

async function boot() {
  const health = await fetch("/health").then((r) => r.json()).catch(() => ({}));
  els.useClaude.disabled = !health.claudeReady;
  els.claudeNote.textContent = health.claudeReady
    ? "(routes the agent through your Claude bridge)"
    : "(Claude key not set — using ElevenLabs' built-in LLM)";

  const [{ customers }, voicesResp] = await Promise.all([
    fetch("/api/customers").then((r) => r.json()),
    fetch("/api/voices").then((r) => r.json()).catch(() => ({ voices: [] })),
  ]);

  profiles = customers;
  els.profile.innerHTML = profiles
    .map((c, i) => `<option value="${i}">${c.industry} — ${c.companyName}</option>`)
    .join("");

  const voices = voicesResp.voices || [];
  els.voiceId.innerHTML = voices
    .map((v) => `<option value="${v.voiceId}">${v.name}</option>`)
    .join("");
  if (!voices.length) {
    els.voiceId.innerHTML = `<option value="">(no voices — check ElevenLabs key)</option>`;
  }

  applyProfile(0);
}

function applyTheme(profileId) {
  const t = THEMES[profileId] || THEMES.energy;
  const root = document.body.style;
  root.setProperty("--accent", t.a);
  root.setProperty("--accent-2", t.a2);
  root.setProperty("--screen-1", t.s[0]);
  root.setProperty("--screen-2", t.s[1]);
  root.setProperty("--screen-3", t.s[2]);
}

function applyProfile(index) {
  const c = profiles[index];
  if (!c) return;
  els.companyName.value = c.companyName;
  els.firstMessage.value = c.greeting;
  els.systemPrompt.value = c.systemPrompt;
  if (c.voiceId) els.voiceId.value = c.voiceId;
  applyTheme(c.id);
  syncScreen();
}

function syncScreen() {
  els.screenCompany.textContent = els.companyName.value || "Demo Company";
}

els.profile.addEventListener("change", (e) => applyProfile(Number(e.target.value)));
els.companyName.addEventListener("input", syncScreen);

// ---- call lifecycle --------------------------------------------------------

function addMsg(text, who) {
  const div = document.createElement("div");
  div.className = `msg ${who}`;
  div.textContent = text;
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function startTimer() {
  seconds = 0;
  els.timer.textContent = "00:00";
  timerHandle = setInterval(() => {
    seconds += 1;
    const m = String(Math.floor(seconds / 60)).padStart(2, "0");
    const s = String(seconds % 60).padStart(2, "0");
    els.timer.textContent = `${m}:${s}`;
  }, 1000);
}
function stopTimer() { clearInterval(timerHandle); timerHandle = null; }

function setMode(mode) {
  els.orb.classList.toggle("speaking", mode === "speaking");
  els.orb.classList.toggle("listening", mode === "listening");
}

async function startCall() {
  els.callBtn.disabled = true;
  els.callState.textContent = "Connecting…";
  els.transcript.innerHTML = "";

  try {
    const resp = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        companyName: els.companyName.value,
        systemPrompt: els.systemPrompt.value,
        firstMessage: els.firstMessage.value,
        voiceId: els.voiceId.value,
        useClaude: els.useClaude.checked,
      }),
    });
    if (!resp.ok) throw new Error((await resp.json()).error || "session failed");
    const { signedUrl, agentId, llm } = await resp.json();
    currentAgentId = agentId;
    els.screenSub.textContent = `mobile · brain: ${llm}`;

    conversation = await Conversation.startSession({
      signedUrl,
      onConnect: () => {
        els.callState.textContent = "Connected";
        els.hangBtn.disabled = false;
        startTimer();
      },
      onDisconnect: () => endCall(),
      onModeChange: ({ mode } = {}) => {
        setMode(mode);
        els.callState.textContent = mode === "speaking" ? "Agent speaking…" : "Listening…";
      },
      onMessage: (m = {}) => {
        // Shape varies; be defensive about field names.
        const text = m.message ?? m.text ?? "";
        if (!text) return;
        const who = m.source === "user" || m.role === "user" ? "user" : "agent";
        addMsg(text, who);
      },
      onError: (e) => {
        console.error(e);
        els.callState.textContent = "Error — see console";
      },
    });
  } catch (err) {
    console.error(err);
    els.callState.textContent = `Failed: ${err.message}`;
    els.callBtn.disabled = false;
  }
}

async function endCall() {
  stopTimer();
  setMode(null);
  els.callState.textContent = "Call ended";
  els.callBtn.disabled = false;
  els.hangBtn.disabled = true;

  try { if (conversation) await conversation.endSession(); } catch {}
  conversation = null;

  // Best-effort cleanup of the demo agent.
  if (currentAgentId) {
    fetch(`/api/session/${currentAgentId}/end`, { method: "POST" }).catch(() => {});
    currentAgentId = null;
  }
}

els.callBtn.addEventListener("click", startCall);
els.hangBtn.addEventListener("click", endCall);

boot().catch((e) => {
  console.error(e);
  els.callState.textContent = "Failed to load — is the server running?";
});
