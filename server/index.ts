import { readFileSync } from "node:fs";
import express from "express";
import dotenv from "dotenv";

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
app.use(express.json({ limit: "200kb" }));

// --- Question list: Claude Haiku 5.5 decides what to add and remove ---------

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY?.trim();
const QUESTION_MODEL = "claude-haiku-5-5";

const QUESTION_SYSTEM =
  "You are an expert consumer-research interviewer for a private equity firm, updating the " +
  "question list of a live voice interview. Follow up on what the person just said: remove " +
  "remaining questions that are answered or no longer fit them, and add up to 2 short " +
  "follow-ups (under 12 words) that serve the interview goal. Reply only with JSON " +
  '{"add":[],"remove":[]}, copying removed questions exactly.';

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
  const { context = "", asked = [], remaining = [], transcript = "" } = req.body ?? {};
  const list = (items: unknown) =>
    Array.isArray(items) && items.length ? items.map((q) => `- ${String(q)}`).join("\n") : "(none)";
  // The context goes into the system prompt, ahead of everything that changes
  // per call. The API keeps no state between calls, so it is still sent every
  // time; putting the unchanging part first is what prompt caching needs.
  const system = context ? `${QUESTION_SYSTEM}\n\nInterview goal:\n${String(context)}` : QUESTION_SYSTEM;
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
        max_tokens: 300,
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
