/**
 * npm run check:openai — confirms OPENAI_API_KEY works and which GPT-6 model the
 * Findings page will use, with one tiny JSON request. Prints no secrets.
 */
import dotenv from "dotenv";
import { resolveModel } from "../server/validation";

dotenv.config();

async function main() {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("No OPENAI_API_KEY in .env");
  const model = await resolveModel(key);
  console.log(`model: ${model}${process.env.OPENAI_MODEL ? " (from OPENAI_MODEL)" : " (auto-detected)"}`);
  const started = Date.now();
  const res = await fetch(`${process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: 'Reply with JSON only: {"ok": true}' }],
      response_format: { type: "json_object" },
      max_completion_tokens: 2000,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`chat/completions ${res.status}: ${text}`);
  const content = (JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]
    ?.message?.content;
  console.log(`reply in ${Date.now() - started} ms: ${content}`);
  console.log("OpenAI is working.");
}

main().catch((e) => {
  console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
