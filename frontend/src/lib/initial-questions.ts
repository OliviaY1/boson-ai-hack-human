import { uid } from "./mock-service";
import type { DiligenceProject, Expert, InvestmentHypothesis, PlanExpert, ResearchPlan } from "./types";

/**
 * Opening questions written by OpenAI (GPT-6) for one person, from the
 * project's investment thesis and the person's description
 * (POST /api/initial-questions on the backend in server/index.ts).
 */
export interface InitialQuestions {
  model: string;
  audience: "customer" | "expert";
  objectives: string;
  hypothesisIds: string[];
  questions: string[];
}

export async function fetchInitialQuestions(
  project: DiligenceProject,
  person: Expert,
  hypotheses: InvestmentHypothesis[],
): Promise<InitialQuestions> {
  const res = await fetch("/api/initial-questions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      company: project.company,
      thesis: project.thesis,
      person: {
        name: person.name,
        title: person.title,
        description: person.description,
        source: person.source,
      },
      hypotheses: hypotheses.map((h) => ({ id: h.id, title: h.title, description: h.description })),
    }),
  });
  const body = (await res.json()) as Partial<InitialQuestions> & {
    error?: string;
    prompt?: { model?: string };
  };
  if (!res.ok || !body.questions?.length) throw new Error(body.error ?? `HTTP ${res.status}`);
  return {
    model: body.prompt?.model ?? "GPT-6",
    audience: body.audience === "customer" ? "customer" : "expert",
    objectives: body.objectives ?? "",
    hypothesisIds: body.hypothesisIds ?? [],
    questions: body.questions,
  };
}

/**
 * Replace one plan entry's questions with Claude's. On failure the entry keeps
 * its template questions and says why.
 */
export async function withClaudeQuestions(
  project: DiligenceProject,
  plan: ResearchPlan,
  pe: PlanExpert,
): Promise<PlanExpert> {
  const person = project.experts.find((e) => e.id === pe.expertId);
  if (!person) return pe;
  try {
    const q = await fetchInitialQuestions(project, person, plan.hypotheses);
    const known = new Set(plan.hypotheses.map((h) => h.id));
    const hypothesisIds = q.hypothesisIds.filter((id) => known.has(id));
    return {
      ...pe,
      audience: q.audience,
      objectives: q.objectives || pe.objectives,
      hypothesisIds: hypothesisIds.length ? hypothesisIds : pe.hypothesisIds,
      questions: q.questions.map((text) => ({ id: uid("q"), text })),
      questionSource: "claude",
      questionNote: `Written by ${q.model} for ${q.audience === "customer" ? "a customer" : "an industry expert"}`,
    };
  } catch (e) {
    return {
      ...pe,
      questionSource: "template",
      questionNote: `Template questions — GPT-6 failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Every person in the plan, in parallel. */
export async function planWithClaudeQuestions(
  project: DiligenceProject,
  plan: ResearchPlan,
): Promise<ResearchPlan> {
  const experts = await Promise.all(plan.experts.map((pe) => withClaudeQuestions(project, plan, pe)));
  return { ...plan, experts };
}
