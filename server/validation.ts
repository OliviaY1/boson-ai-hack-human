import type { Express } from "express";

/**
 * Investment thesis validation with OpenAI (GPT-6).
 *
 *   POST /api/thesis-validation
 *     { company, thesis, hypotheses: [{ id, title, description, evidence }],
 *       interviews: [{ id, name, title, description, audience, status,
 *                      transcript: [{ speaker: "interviewer" | "interviewee", text }] }] }
 *   -> { model, overall: { verdict, summary },
 *        hypotheses: [{ id, assessment, confidence, rationale,
 *                       evidence: [{ interviewId, quote, stance }] }],
 *        gaps: [{ hypothesisId, gap, nextStep, priority }],
 *        droppedQuotes, ms }
 *
 * The key comes from OPENAI_API_KEY in .env (never sent to the browser).
 * The model is OPENAI_MODEL, or else the first GPT-6 model this key can use
 * (GET /v1/models), in PREFERRED order.
 *
 * Quotes are checked: any quote that does not appear in that interview's own
 * interviewee turns is dropped and counted in `droppedQuotes`, so the page
 * never shows invented evidence.
 */

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const PREFERRED = ["gpt-6", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];

const SYSTEM = `You are a senior private equity diligence analyst. You test an investment thesis against primary research: short phone interviews (about one minute each) with customers and industry experts.

For each hypothesis, decide from the interview evidence alone:
- "Supported": interviewees give concrete statements that back it, and nothing material contradicts it.
- "Contradicted": the evidence points against it.
- "Mixed Evidence": credible statements on both sides.
- "Insufficient Evidence": not discussed, only vague remarks, or a single anecdote that cannot carry the hypothesis.

Rules:
- Use only what interviewees said. Do not use outside knowledge about the company or market, and do not treat the interviewer's questions as evidence.
- Calls are short, so be conservative. A lone customer's opinion is weak evidence; an expert's specific, first-hand statement is stronger. Say so in the rationale.
- Quote interviewees VERBATIM: copy exact words from an interviewee turn of the cited interview (at most 25 words). Never paraphrase inside a quote.
- confidence is "high", "medium" or "low" and reflects how much evidence there is and how good it is.
- rationale: 1-3 plain sentences a partner can read in ten seconds; name what would change the assessment if evidence is thin.
- overall.verdict is one of "Supported", "Partially supported", "Not supported", "Insufficient evidence"; overall.summary is 2-3 sentences on the thesis as a whole.

Then list the research gaps: what this research has NOT yet established, consistent with your assessments above. Look for hypotheses with no or thin evidence, claims resting on a single interviewee or only on customers, contradictions between interviewees, and planned questions that went unanswered (the interviewer asked but got no real answer, or the call ended first). For each gap give:
- hypothesis_id: the hypothesis it concerns, or null if it is about the thesis overall;
- gap: one sentence on what is missing and why it matters for the investment decision;
- next_step: one concrete action — who to talk to next (type of customer or expert) and the question to ask, or the data to request;
- priority: "high" if the thesis cannot be relied on without it, "medium", or "low".
List at most 6 gaps, highest priority first. Do not invent gaps that the evidence already closes.

Reply with JSON only, exactly this shape:
{"overall":{"verdict":"...","summary":"..."},"hypotheses":[{"id":"...","assessment":"...","confidence":"...","rationale":"...","evidence":[{"interview_id":"...","quote":"...","stance":"support|contradict|neutral"}]}],"gaps":[{"hypothesis_id":"...","gap":"...","next_step":"...","priority":"high|medium|low"}]}
Include every hypothesis id you were given, in the same order.`;

interface Turn {
  speaker: "interviewer" | "interviewee";
  text: string;
}
interface InterviewIn {
  id: string;
  name?: string;
  title?: string;
  description?: string;
  audience?: string;
  status?: string;
  transcript?: Turn[];
}
interface HypothesisIn {
  id: string;
  title?: string;
  description?: string;
  evidence?: string;
}

const ASSESSMENTS = ["Supported", "Contradicted", "Mixed Evidence", "Insufficient Evidence"] as const;
const VERDICTS = ["Supported", "Partially supported", "Not supported", "Insufficient evidence"] as const;

let cachedModel: string | null = null;

/** OPENAI_MODEL, or the first GPT-6 model this key can see. */
export async function resolveModel(apiKey: string): Promise<string> {
  const fixed = process.env.OPENAI_MODEL?.trim();
  if (fixed) return fixed;
  if (cachedModel) return cachedModel;
  const res = await fetch(`${OPENAI_BASE_URL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI /models ${res.status}: ${text}`);
  const ids = ((JSON.parse(text) as { data?: Array<{ id: string }> }).data ?? []).map((m) => m.id);
  const pick =
    PREFERRED.find((p) => ids.includes(p)) ?? ids.filter((id) => id.startsWith("gpt-6")).sort()[0];
  if (!pick) {
    throw new Error(
      `No GPT-6 model is available to this key. Set OPENAI_MODEL in .env. Models seen: ${ids
        .filter((id) => id.startsWith("gpt"))
        .slice(0, 20)
        .join(", ")}`,
    );
  }
  cachedModel = pick;
  return pick;
}

/** One Chat Completions call that must return a JSON object. */
export async function chatJson(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      // Room for reasoning models, which spend completion tokens thinking.
      max_completion_tokens: 12000,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI ${model} ${res.status}: ${text}`);
  const data = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  };
  const choice = data.choices?.[0];
  const content = choice?.message?.content ?? "";
  // A reply cut off by the token limit is incomplete JSON: say so instead of failing to parse it.
  if (choice?.finish_reason === "length") {
    throw new Error(`OpenAI ${model} hit the output token limit before finishing its reply.`);
  }
  if (!content) throw new Error(`OpenAI ${model} returned no content: ${text.slice(0, 500)}`);
  return content;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function buildUserMessage(company: string, thesis: string, hyps: HypothesisIn[], ivs: InterviewIn[]): string {
  const hypText = hyps
    .map(
      (h) =>
        `- ${h.id}: ${h.title ?? ""}${h.description ? ` — ${h.description}` : ""}${
          h.evidence ? ` (evidence that would count: ${h.evidence})` : ""
        }`,
    )
    .join("\n");
  const ivText = ivs
    .map((iv) => {
      const who = [iv.name, iv.title, iv.audience].filter(Boolean).join(", ");
      const lines = (iv.transcript ?? [])
        .map((t) => `${t.speaker === "interviewer" ? "Interviewer" : "Interviewee"}: ${t.text}`)
        .join("\n");
      return `### Interview ${iv.id} — ${who}\nAbout the interviewee: ${iv.description ?? ""}\nStatus: ${
        iv.status ?? ""
      }\n${lines || "(no transcript)"}`;
    })
    .join("\n\n");
  return `Company: ${company}\n\nInvestment thesis:\n${thesis || "(not given)"}\n\nHypotheses:\n${hypText}\n\nInterviews:\n\n${ivText}`;
}

export function registerValidationRoute(app: Express): void {
  app.post("/api/thesis-validation", async (req, res) => {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) return res.status(500).json({ error: "No OPENAI_API_KEY in .env." });
    const body = (req.body ?? {}) as {
      company?: string;
      thesis?: string;
      hypotheses?: HypothesisIn[];
      interviews?: InterviewIn[];
    };
    const hyps = Array.isArray(body.hypotheses) ? body.hypotheses : [];
    const ivs = Array.isArray(body.interviews) ? body.interviews : [];
    if (!hyps.length) return res.status(400).json({ error: "No hypotheses to validate." });

    const startedAt = Date.now();
    let model = "";
    try {
      model = await resolveModel(apiKey);
      const user = buildUserMessage(String(body.company ?? ""), String(body.thesis ?? ""), hyps, ivs);
      const raw = await chatJson(apiKey, model, SYSTEM, user);
      const parsed = JSON.parse(raw) as {
        overall?: { verdict?: string; summary?: string };
        hypotheses?: Array<{
          id?: string;
          assessment?: string;
          confidence?: string;
          rationale?: string;
          evidence?: Array<{ interview_id?: string; quote?: string; stance?: string }>;
        }>;
        gaps?: Array<{ hypothesis_id?: string | null; gap?: string; next_step?: string; priority?: string }>;
      };

      // Interviewee words per interview, for checking quotes.
      const spoken = new Map(
        ivs.map((iv) => [
          iv.id,
          norm((iv.transcript ?? []).filter((t) => t.speaker === "interviewee").map((t) => t.text).join(" ")),
        ]),
      );
      let droppedQuotes = 0;
      const byId = new Map((parsed.hypotheses ?? []).map((h) => [String(h.id ?? ""), h]));
      const hypotheses = hyps.map((h) => {
        const got = byId.get(h.id);
        const assessment = ASSESSMENTS.find((a) => a === got?.assessment) ?? "Insufficient Evidence";
        const evidence = (got?.evidence ?? []).flatMap((e) => {
          const interviewId = String(e.interview_id ?? "");
          const quote = String(e.quote ?? "").trim();
          const words = norm(quote);
          if (!quote || !words || !(spoken.get(interviewId) ?? "").includes(words)) {
            droppedQuotes++;
            return [];
          }
          const stance = e.stance === "support" || e.stance === "contradict" ? e.stance : "neutral";
          return [{ interviewId, quote, stance }];
        });
        return {
          id: h.id,
          assessment,
          confidence: got?.confidence === "high" || got?.confidence === "medium" ? got.confidence : "low",
          rationale: String(got?.rationale ?? "No assessment returned for this hypothesis."),
          evidence,
        };
      });
      const verdict = VERDICTS.find((v) => v === parsed.overall?.verdict) ?? "Insufficient evidence";
      const knownIds = new Set(hyps.map((h) => h.id));
      const gaps = (parsed.gaps ?? [])
        .filter((g) => typeof g.gap === "string" && g.gap.trim())
        .slice(0, 6)
        .map((g) => ({
          hypothesisId: g.hypothesis_id && knownIds.has(g.hypothesis_id) ? g.hypothesis_id : null,
          gap: String(g.gap).trim(),
          nextStep: String(g.next_step ?? "").trim(),
          priority: g.priority === "high" || g.priority === "medium" ? g.priority : "low",
        }));
      return res.json({
        model,
        overall: { verdict, summary: String(parsed.overall?.summary ?? "") },
        hypotheses,
        gaps,
        droppedQuotes,
        ms: Date.now() - startedAt,
      });
    } catch (err) {
      console.error("thesis validation error:", err);
      return res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
        model,
        ms: Date.now() - startedAt,
      });
    }
  });
}
