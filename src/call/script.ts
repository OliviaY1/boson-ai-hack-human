/**
 * The interview script: defaults, the short instructions sent per step, and the
 * Claude question-update call. Shared by the debug UI (src/App.tsx) and the
 * consultant dashboard (frontend/, through CallController).
 */

/** Greeting instructions, sent in the first session.update. */
export const DEFAULT_INSTRUCTIONS = `You are Alexa from a private equity firm. Say exactly: "Hi, I'm Alexa from a private equity firm. Do you have one minute for a few quick questions about Nike?" Nothing else.`;

/** What the interview is for. Sent to Claude as context with every call. */
export const DEFAULT_GOAL =
  "Private equity consumer research on Nike: which sports brands people buy and why, " +
  "how their Nike spending is changing, and, for people who don't buy Nike or sports " +
  "brands, why not.";

export const DEFAULT_QUESTIONS = [
  "Which sports brand do you buy most?",
  "Why that brand?",
  "Are you buying more Nike this year, or less?",
].join("\n");

/** Said after the last answer, or straight after a declined greeting. */
export const DEFAULT_CLOSING =
  "That's all my questions. Thank you so much for your time, have a great day!";

export type Audience = "customer" | "expert";

/** The short instructions sent for each question. */
export function questionInstructions(question: string): string {
  return `You are Alexa, a market researcher. Say exactly: "${question}" Nothing else.`;
}

/**
 * The step right after the greeting: the model itself decides whether the
 * person agreed. It is sent when the greeting ends, before they answer, so the
 * code cannot know their answer yet.
 */
export function firstQuestionInstructions(question: string, closing: string): string {
  return `You are Alexa, a market researcher. If the person said no, declined, or has no time, say exactly: "${closing}" Otherwise say exactly: "${question}" Nothing else.`;
}

/** Did this reply say this line? Compared word by word, ignoring case and punctuation. */
export function saidLine(reply: string, line: string): boolean {
  const words = (t: string) => t.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const target = words(line);
  if (target.length === 0) return false;
  const said = new Set(words(reply));
  const hits = target.filter((w) => said.has(w)).length;
  return hits / target.length >= 0.8;
}

/** A question box as a list: one per line, blanks dropped. */
export function splitQuestions(text: string): string[] {
  return text
    .split("\n")
    .map((q) => q.trim())
    .filter(Boolean);
}

/** One call to POST /api/questions, as the UIs show it. */
export interface QuestionChangeResult {
  status: "ok" | "error";
  model?: string;
  system?: string;
  user?: string;
  raw?: string;
  add?: string[];
  remove?: string[];
  error?: string;
  ms?: number;
}

/**
 * Ask Claude Haiku 5.5 (through our server) what to add to and remove from the
 * questions not asked yet. Never throws; failures come back as status "error".
 */
export async function fetchQuestionChanges(payload: {
  context: string;
  audience: Audience;
  asked: string[];
  remaining: string[];
  transcript: string;
}): Promise<QuestionChangeResult> {
  try {
    const res = await fetch("/api/questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as {
      prompt?: { model?: string; system?: string; user?: string };
      ms?: number;
      error?: string;
      raw?: string;
      add?: string[];
      remove?: string[];
    };
    const result: QuestionChangeResult = { status: res.ok ? "ok" : "error" };
    if (body.prompt?.model !== undefined) result.model = body.prompt.model;
    if (body.prompt?.system !== undefined) result.system = body.prompt.system;
    if (body.prompt?.user !== undefined) result.user = body.prompt.user;
    if (body.ms !== undefined) result.ms = body.ms;
    if (!res.ok) {
      result.error = body.error ?? `HTTP ${res.status}`;
      return result;
    }
    if (body.raw !== undefined) result.raw = body.raw;
    result.add = body.add ?? [];
    result.remove = body.remove ?? [];
    return result;
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}
