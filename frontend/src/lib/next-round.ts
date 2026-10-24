import { useCallback, useEffect, useRef, useState } from "react";
import { allHypotheses, allInterviews, uid } from "./mock-service";
import { interviewsPayload } from "./thesis-validation";
import type {
  DiligenceProject,
  Expert,
  InvestmentHypothesis,
  NextRoundProposal,
  PlanExpert,
} from "./types";

/**
 * The next research round, proposed by GPT-6 (POST /api/next-round,
 * server/validation.ts) from everything so far: the thesis and hypotheses,
 * GPT-6's latest assessments and research gaps, every completed transcript,
 * and the contact list. It proposes sharper hypotheses, who to interview
 * (existing contacts or new profiles to recruit) and their questions.
 * The proposal is saved on the project; a newer thesis validation re-proposes.
 */

interface NextRoundResponse {
  model: string;
  hypotheses: Array<{ basedOn: string | null; title: string; description: string; why: string }>;
  people: Array<{
    contactId: string | null;
    name: string;
    title: string;
    description: string;
    audience: "customer" | "expert";
    reason: string;
    objectives: string;
    tests: number[];
    questions: string[];
  }>;
  error?: string;
}

async function requestNextRound(p: DiligenceProject): Promise<NextRoundProposal> {
  const v = p.thesisValidation;
  if (!v) throw new Error("Validate the thesis first.");
  const roundNo = (p.pastRounds?.length ?? 0) + 2;
  const all = allHypotheses(p);
  const interviewed = new Set(
    allInterviews(p)
      .filter((iv) => iv.status === "Completed")
      .map((iv) => iv.expertId),
  );
  const res = await fetch("/api/next-round", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      company: p.company,
      thesis: p.thesis,
      round: roundNo,
      hypotheses: all.map((h) => {
        const a = v.hypotheses.find((x) => x.id === h.id);
        return {
          id: h.id,
          title: h.title,
          description: h.description,
          assessment: a?.assessment ?? "not assessed",
          rationale: a?.rationale ?? "",
        };
      }),
      gaps: v.gaps,
      interviews: interviewsPayload(p),
      contacts: p.experts.map((e) => ({
        id: e.id,
        name: e.name,
        title: e.title,
        description: e.description,
        interviewed: interviewed.has(e.id),
      })),
    }),
  });
  const body = (await res.json()) as NextRoundResponse;
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);

  // Hypotheses for the new round, with where each came from.
  const why: Record<string, string> = {};
  const hypotheses: InvestmentHypothesis[] = body.hypotheses.map((h, i) => {
    const id = `h-r${roundNo}-${i + 1}`;
    const base = h.basedOn ? all.find((x) => x.id === h.basedOn) : undefined;
    const idx = base ? all.indexOf(base) + 1 : 0;
    const assessment = base ? v.hypotheses.find((x) => x.id === base.id)?.assessment : undefined;
    why[id] = h.why;
    const out: InvestmentHypothesis = {
      id,
      title: h.title,
      description: h.description,
      evidence: base?.evidence ?? h.description,
      origin: base ? `Refined from H${idx}${assessment ? ` · ${assessment}` : ""}` : "New",
      round: roundNo,
    };
    return out;
  });

  // People: existing contacts by id; new profiles become contacts on "Create".
  const newExperts: Expert[] = [];
  const experts: PlanExpert[] = body.people.map((person) => {
    let expertId = person.contactId;
    if (!expertId) {
      const e: Expert = {
        id: uid("e"),
        name: person.name,
        title: person.title || "Recommended interviewee",
        phone: "",
        description: person.description,
        source: "Custom",
      };
      newExperts.push(e);
      expertId = e.id;
    }
    const tests = person.tests.map((i) => hypotheses[i]?.id).filter((x): x is string => !!x);
    return {
      expertId,
      reason: person.reason,
      hypothesisIds: tests.length ? tests : hypotheses.map((h) => h.id),
      objectives: person.objectives,
      questions: person.questions.map((text) => ({ id: uid("q"), text })),
      audience: person.audience,
      questionSource: "claude",
      questionNote: `Written by ${body.model} for round ${roundNo} (${person.audience === "customer" ? "a customer" : "an industry expert"})`,
    };
  });

  return {
    at: new Date().toISOString(),
    model: body.model,
    basedOn: v.at,
    plan: { hypotheses, experts, approved: false },
    newExperts,
    why,
  };
}

/** Archive this round and make GPT-6's proposal the new plan (adding any new people as contacts). */
export function startNextRoundFrom(p: DiligenceProject, proposal: NextRoundProposal): DiligenceProject {
  const { plan, newExperts } = proposal;
  const { nextRound: _used, ...rest } = p;
  return {
    ...rest,
    pastRounds: [...(p.pastRounds ?? []), { plan: p.plan!, interviews: p.interviews }],
    plan,
    interviews: [],
    experts: [...p.experts, ...newExperts.filter((e) => !p.experts.some((x) => x.id === e.id))],
    selectedExpertIds: [...new Set([...(p.selectedExpertIds ?? []), ...plan.experts.map((e) => e.expertId)])],
  };
}

export function useNextRound(
  project: DiligenceProject,
  update: (fn: (p: DiligenceProject) => DiligenceProject) => void,
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const basis = project.thesisValidation?.at ?? "";
  const proposal = project.nextRound && project.nextRound.basedOn === basis ? project.nextRound : undefined;

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setLoading(true);
    setError("");
    try {
      const next = await requestNextRound(project);
      update((p) => ({ ...p, nextRound: next }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      running.current = false;
      setLoading(false);
    }
  }, [project, update]);

  // Propose once per thesis validation (not again after an error; Retry does).
  const tried = useRef("");
  useEffect(() => {
    if (!basis || proposal || tried.current === basis) return;
    tried.current = basis;
    void run();
  }, [basis, proposal, run]);

  return { proposal, loading: loading || (!!basis && !proposal && !error), error, run };
}
