import { readFileSync } from "node:fs";
import express from "express";
import dotenv from "dotenv";
import { HttpError, loadLiveKitConfig, startAvatar, stopAvatar } from "./avatar";
import { registerInterviewRoutes } from "./interviews";
import { chatJson, registerNextRoundRoute, registerValidationRoute, resolveModel } from "./validation";

dotenv.config();

const PORT = Number(process.env.PORT ?? 3000);
const BOSON_BASE_URL = process.env.BOSON_BASE_URL ?? "https://api.boson.ai";

// How long a minted ephemeral key stays valid. The API accepts 10–7200 seconds
// and defaults to 600. Short is good: the key is handed to a browser, and a
// fresh one is minted for every connection anyway.
const EPHEMERAL_TTL_SECONDS = 600;

/**
 * The API key comes from BOSON_API_KEY, or from a file whose path is in
 * BOSON_API_KEY_FILE. Reading it from a file keeps the secret out of your shell
 * history and out of .env — useful if you already keep keys somewhere central.
 */
function loadApiKey(): string | undefined {
  const inline = process.env.BOSON_API_KEY?.trim();
  if (inline) return inline;

  const keyFile = process.env.BOSON_API_KEY_FILE;
  if (keyFile) {
    try {
      const fromFile = readFileSync(keyFile, "utf8").trim();
      if (fromFile) {
        console.log(`Loaded BOSON_API_KEY from ${keyFile}`);
        return fromFile;
      }
    } catch {
      console.warn(`Could not read BOSON_API_KEY_FILE at ${keyFile}`);
    }
  }
  return undefined;
}

const BOSON_API_KEY = loadApiKey();

const app = express();
app.use(express.json({ limit: "2mb" }));
registerInterviewRoutes(app);
registerValidationRoute(app);
registerNextRoundRoute(app);

// --- Question list: Claude Haiku 5.5 decides what to add and remove ---------

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY?.trim();
const QUESTION_MODEL = "claude-haiku-5-5";

const QUESTION_SYSTEM =
  "You are an expert consumer-research interviewer for a private equity firm, updating the " +
  "question list of a live phone interview that lasts only about one minute, so keep the list " +
  "short. Follow up on what the person just said: remove remaining questions that are answered " +
  "or no longer fit them, and add up to 2 short follow-ups (under 12 words) that serve the " +
  "interview goal. Reply only with JSON " +
  '{"add":[],"remove":[]}, copying removed questions exactly.';

const AUDIENCE_STYLE: Record<string, string> = {
  customer:
    "The interviewee is a customer: use everyday words, one simple idea per question, easy to answer in a few seconds.",
  expert:
    "The interviewee is an industry expert: questions can be analytical and use industry terms (market share, pricing power, channels, margins).",
};

/**
 * POST /api/questions  { context, asked: string[], remaining: string[], transcript }
 *   -> { add: string[], remove: string[] }
 *
 * The Anthropic key stays here, on the server, like the Boson key.
 */
app.post("/api/questions", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "No ANTHROPIC_API_KEY in .env." });
  }
  const { context = "", audience = "customer", asked = [], remaining = [], transcript = "" } =
    req.body ?? {};
  const list = (items: unknown) =>
    Array.isArray(items) && items.length ? items.map((q) => `- ${String(q)}`).join("\n") : "(none)";
  // The context goes into the system prompt, ahead of everything that changes
  // per call. The API keeps no state between calls, so it is still sent every
  // time; putting the unchanging part first is what prompt caching needs.
  const style = AUDIENCE_STYLE[String(audience)] ?? AUDIENCE_STYLE.customer;
  const system = [QUESTION_SYSTEM, style, context ? `Interview goal:\n${String(context)}` : ""]
    .filter(Boolean)
    .join("\n\n");
  const userMessage = [
    `Already asked:\n${list(asked)}`,
    `Remaining, in order:\n${list(remaining)}`,
    `Transcript so far:\n${String(transcript)}`,
  ].join("\n\n");

  // Echoed back to the browser so the UI can show exactly what was sent.
  const prompt = { model: QUESTION_MODEL, system, user: userMessage };
  const startedAt = Date.now();
  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: QUESTION_MODEL,
        // Generous: a reply cut off by the limit is incomplete JSON and reads as "no change".
        max_tokens: 2000,
        system,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    const body = await upstream.text();
    if (!upstream.ok) {
      console.error(`anthropic ${upstream.status}: ${body}`);
      return res
        .status(upstream.status)
        .json({ error: `Anthropic ${upstream.status}: ${body}`, prompt, ms: Date.now() - startedAt });
    }
    const data = JSON.parse(body) as { content?: Array<{ type: string; text?: string }> };
    const text = (data.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    // Take the first {...} in the reply, in case the model wraps it in prose.
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = match ? (JSON.parse(match[0]) as { add?: unknown; remove?: unknown }) : {};
    const strings = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
    return res.json({
      add: strings(parsed.add),
      remove: strings(parsed.remove),
      raw: text,
      prompt,
      ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("question update error:", err);
    return res.status(502).json({
      error: err instanceof Error ? err.message : String(err),
      prompt,
      ms: Date.now() - startedAt,
    });
  }
});

/**
 * GET /api/token
 *
 * This server exists for exactly one reason: your real API key must never reach
 * the browser. Anything the browser can read, a visitor can read — and a leaked
 * key is billable until you rotate it.
 *
 * So the browser asks *us* for a key, and we ask Boson for a short-lived
 * "ephemeral" one (`bai-eph-…`) using the real key. The browser gets only the
 * ephemeral value, which expires on its own in ten minutes.
 *
 * A fresh key is minted per request. Do not cache them.
 */
app.get("/api/token", async (_req, res) => {
  if (!BOSON_API_KEY) {
    return res.status(500).json({
      error:
        "No API key found. Set BOSON_API_KEY in .env, or point BOSON_API_KEY_FILE at a key file.",
    });
  }

  try {
    const upstream = await fetch(`${BOSON_BASE_URL}/v1/realtime/client_secrets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BOSON_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expires_after: { seconds: EPHEMERAL_TTL_SECONDS } }),
    });

    const text = await upstream.text();

    if (!upstream.ok) {
      console.error(`client_secrets failed: ${upstream.status} ${text}`);
      return res
        .status(upstream.status)
        .json({ error: `Upstream ${upstream.status}: ${text || upstream.statusText}` });
    }

    // The upstream response also carries a `session` object. The browser does
    // not need it, so we do not forward it — return the minimum.
    const data = JSON.parse(text);
    return res.json({ value: data.value, expires_at: data.expires_at });
  } catch (err) {
    console.error("Token mint error:", err);
    return res.status(502).json({
      error: err instanceof Error ? err.message : "Failed to reach the Boson API",
    });
  }
});

// --- Initial questions: OpenAI (GPT-6) writes the opening questions per person ---

const INITIAL_SYSTEM = [
  "You design the opening questions for a short phone interview that a private equity firm's",
  "AI interviewer places to test an investment thesis. The call lasts about one minute and",
  "every question is spoken aloud.",
  "First decide who the person is: a customer (buys or uses the company's products or",
  "services) or an industry expert (former employee, competitor, supplier, consultant,",
  "analyst).",
  "Then write the questions in the order to ask them: 3 for a customer, 4 for an expert.",
  "Each one tests the thesis from this person's vantage point and is something they can",
  "actually answer; under 15 words; one idea; open-ended, not yes/no; spoken English;",
  "everyday words for customers, industry terms are fine for experts; no greeting, no",
  "request for confidential information.",
  "Also write the interview objectives in one sentence, and list the ids of the hypotheses",
  "the questions test (only ids that were given).",
  'Reply with JSON only: {"audience":"customer"|"expert","objectives":"...",',
  '"hypothesis_ids":["..."],"questions":["..."]}',
].join(" ");

/**
 * POST /api/initial-questions
 *   { company, thesis, person: { name, title, description, source },
 *     hypotheses?: [{ id, title, description }] }
 *   -> { audience, objectives, hypothesisIds, questions, raw, prompt, ms }
 */
app.post("/api/initial-questions", async (req, res) => {
  // Written by OpenAI (GPT-6), like the Findings page.
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  if (!openaiKey) return res.status(500).json({ error: "No OPENAI_API_KEY in .env." });
  const { company = "", thesis = "", person = {}, hypotheses = [] } = req.body ?? {};
  const p = person as { name?: string; title?: string; description?: string; source?: string };
  const hyps = Array.isArray(hypotheses)
    ? (hypotheses as Array<{ id?: string; title?: string; description?: string }>)
    : [];
  const user = [
    `Company: ${String(company)}`,
    `Investment thesis: ${String(thesis) || "(not given)"}`,
    hyps.length
      ? `Hypotheses:\n${hyps.map((h) => `- ${h.id}: ${h.title}${h.description ? ` — ${h.description}` : ""}`).join("\n")}`
      : "",
    [
      "Person to call:",
      `- Name: ${p.name ?? ""}`,
      `- Title: ${p.title ?? ""}`,
      `- Source: ${p.source ?? ""}`,
      `- Description: ${p.description ?? ""}`,
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
  const startedAt = Date.now();
  let model = "";
  try {
    model = await resolveModel(openaiKey);
    const raw = await chatJson(openaiKey, model, INITIAL_SYSTEM, user);
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = (match ? JSON.parse(match[0]) : {}) as {
      audience?: unknown;
      objectives?: unknown;
      hypothesis_ids?: unknown;
      questions?: unknown;
    };
    const strings = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
    const questions = strings(parsed.questions).map((q) => q.trim());
    if (!questions.length) throw new Error(`No questions in the reply: ${raw}`);
    return res.json({
      audience: parsed.audience === "customer" ? "customer" : "expert",
      objectives: typeof parsed.objectives === "string" ? parsed.objectives : "",
      hypothesisIds: strings(parsed.hypothesis_ids),
      questions,
      raw,
      prompt: { model, system: INITIAL_SYSTEM, user },
      ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("initial questions error:", err);
    return res.status(502).json({
      error: err instanceof Error ? err.message : String(err),
      prompt: { model, system: INITIAL_SYSTEM, user },
      ms: Date.now() - startedAt,
    });
  }
});

// --- Higgs Avatar ---------------------------------------------------------------

const DEFAULT_AVATAR_ID = "builtin_claire_v1";
// Interviews take about a minute; a short cap means a session left behind by a
// crashed or closed tab frees its avatar slot quickly.
const AVATAR_MAX_DURATION_SECONDS = 180;

/** Avatar sessions this server started and has not ended, released on shutdown. */
const activeAvatarSessions = new Set<string>();

async function releaseAvatars(): Promise<void> {
  if (!BOSON_API_KEY || !activeAvatarSessions.size) return;
  const ids = [...activeAvatarSessions];
  activeAvatarSessions.clear();
  await Promise.all(
    ids.map((id) =>
      stopAvatar({ baseUrl: BOSON_BASE_URL, apiKey: BOSON_API_KEY! }, id)
        .then(() => console.log(`avatar session ${id} released on shutdown`))
        .catch(() => undefined),
    ),
  );
}

// A restart (tsx watch after a pull) or Ctrl+C must not leave avatars holding slots.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void releaseAvatars().finally(() => process.exit(0));
  });
}

/**
 * POST /api/avatar/start  { avatarId? }
 *   -> { sessionId, url, roomName, token, avatarIdentity, publisherIdentity, ... }
 *
 * Creates a LiveKit room, mints the avatar's and the browser's tokens, and
 * starts a Boson avatar session in that room. The browser then joins with
 * `token` and streams Higgs Realtime's audio to the avatar.
 */
app.post("/api/avatar/start", async (req, res) => {
  const livekit = loadLiveKitConfig();
  if (!BOSON_API_KEY) return res.status(500).json({ error: "No BOSON_API_KEY in .env." });
  if (!livekit) {
    return res
      .status(500)
      .json({ error: "Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET in .env." });
  }
  const avatarId = String(req.body?.avatarId || DEFAULT_AVATAR_ID);
  try {
    const result = await startAvatar({
      boson: { baseUrl: BOSON_BASE_URL, apiKey: BOSON_API_KEY },
      livekit,
      avatarId,
      maxDurationSeconds: AVATAR_MAX_DURATION_SECONDS,
    });
    activeAvatarSessions.add(result.sessionId);
    console.log(`avatar session ${result.sessionId} started in room ${result.roomName}`);
    return res.json(result);
  } catch (err) {
    console.error("avatar start error:", err);
    if (err instanceof HttpError) {
      if (err.retryAfter) res.setHeader("Retry-After", err.retryAfter);
      return res.status(err.status).json({ error: err.message, retryAfter: err.retryAfter });
    }
    return res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /api/avatar/stop  { sessionId } — DELETE /v1/avatar/sessions/{id}. */
app.post("/api/avatar/stop", async (req, res) => {
  const sessionId = String(req.body?.sessionId ?? "");
  if (!BOSON_API_KEY || !sessionId) return res.status(400).json({ error: "sessionId required" });
  try {
    activeAvatarSessions.delete(sessionId);
    const session = await stopAvatar({ baseUrl: BOSON_BASE_URL, apiKey: BOSON_API_KEY }, sessionId);
    console.log(`avatar session ${sessionId} released`);
    return res.json({ ok: true, session });
  } catch (err) {
    console.error("avatar stop error:", err);
    const status = err instanceof HttpError ? err.status : 502;
    return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Token server listening on http://localhost:${PORT}`);
  if (!ANTHROPIC_API_KEY) {
    console.warn("  ⚠ No ANTHROPIC_API_KEY in .env — /api/questions will return 500.");
  }
  if (!BOSON_API_KEY) {
    console.warn(
      "  ⚠ No API key found (set BOSON_API_KEY or BOSON_API_KEY_FILE in .env) — /api/token will return 500.",
    );
  }
});
