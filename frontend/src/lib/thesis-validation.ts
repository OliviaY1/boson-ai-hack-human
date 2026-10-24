import { useCallback, useEffect, useRef, useState } from "react";
import { allHypotheses, allInterviews } from "./mock-service";
import type { DiligenceProject, ThesisValidationResult } from "./types";

/**
 * Investment thesis validation by GPT-6 (POST /api/thesis-validation on the
 * backend, server/validation.ts): the project's thesis and hypotheses, checked
 * against the transcripts of COMPLETED interviews only. The result is saved on
 * the project and recomputed when its inputs change (a new interview finishes,
 * the thesis is edited).
 */

function completedInterviews(p: DiligenceProject) {
  return allInterviews(p).filter((iv) => iv.status === "Completed" && iv.transcript.length > 0);
}

/** A fingerprint of everything the validation depends on. */
export function validationInputKey(p: DiligenceProject): string {
  const ivs = completedInterviews(p)
    .map((iv) => `${iv.id}:${iv.transcript.length}:${iv.transcript.at(-1)?.text.length ?? 0}`)
    .join(",");
  const hyps = allHypotheses(p)
    .map((h) => `${h.id}:${h.title}`)
    .join(",");
  return `${p.thesis.length}:${p.thesis.slice(0, 40)}|${hyps}|${ivs}`;
}

/** Completed interviews as the backend expects them (who, and the transcript). */
export function interviewsPayload(p: DiligenceProject) {
  return completedInterviews(p).map((iv) => {
    const person = p.experts.find((e) => e.id === iv.expertId);
    const planned = [p.plan, ...(p.pastRounds ?? []).map((r) => r.plan)]
      .flatMap((pl) => pl?.experts ?? [])
      .find((e) => e.expertId === iv.expertId);
    return {
      id: iv.id,
      name: person?.name ?? "",
      title: person?.title ?? "",
      description: person?.description ?? "",
      audience: planned?.audience ?? "",
      status: iv.status,
      transcript: iv.transcript.map((t) => ({
        speaker: t.speaker === "ai" ? "interviewer" : "interviewee",
        text: t.text,
      })),
    };
  });
}

async function requestValidation(p: DiligenceProject): Promise<ThesisValidationResult> {
  const ivs = completedInterviews(p);
  const res = await fetch("/api/thesis-validation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      company: p.company,
      thesis: p.thesis,
      hypotheses: allHypotheses(p).map((h) => ({
        id: h.id,
        title: h.title,
        description: h.description,
        evidence: h.evidence,
      })),
      interviews: interviewsPayload(p),
    }),
  });
  const body = (await res.json()) as Omit<ThesisValidationResult, "at" | "inputKey" | "interviewCount"> & {
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return {
    at: new Date().toISOString(),
    model: body.model,
    inputKey: validationInputKey(p),
    interviewCount: ivs.length,
    overall: body.overall,
    hypotheses: body.hypotheses,
    gaps: body.gaps ?? [],
    droppedQuotes: body.droppedQuotes ?? 0,
  };
}

export function useThesisValidation(
  project: DiligenceProject,
  update: (fn: (p: DiligenceProject) => DiligenceProject) => void,
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const key = validationInputKey(project);
  const hasEvidence = completedInterviews(project).length > 0;
  const cached = project.thesisValidation;
  const stale = !cached || cached.inputKey !== key;

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setLoading(true);
    setError("");
    try {
      const result = await requestValidation(project);
      update((p) => ({ ...p, thesisValidation: result }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      running.current = false;
      setLoading(false);
    }
  }, [project, update]);

  // Run once when there is evidence and no up-to-date result (not again after an error).
  const tried = useRef("");
  useEffect(() => {
    if (!hasEvidence || !stale || tried.current === key) return;
    tried.current = key;
    void run();
  }, [hasEvidence, stale, key, run]);

  return { result: cached, stale, loading, error, run, hasEvidence };
}
