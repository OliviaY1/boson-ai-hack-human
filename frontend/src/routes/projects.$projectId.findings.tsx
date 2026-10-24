import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, Compass, FileText, Loader2, RefreshCw } from "lucide-react";
import { expertOf } from "@/components/research";
import { AssessmentBadge } from "@/components/status";
import { Badge, Button, buttonVariants, Card, EmptyState, SectionTitle } from "@/components/ui-kit";
import {
  allHypotheses,
  allInterviews,
  canRecommendNextRound,
  generateMockFindings,
  thesisPillars,
} from "@/lib/mock-service";
import { useProject } from "@/lib/store";
import { useRoundView } from "@/lib/round-view";
import type { DiligenceProject, Finding, Interview } from "@/lib/types";
import { useThesisValidation } from "@/lib/thesis-validation";
import { startNextRoundFrom, useNextRound } from "@/lib/next-round";
import { useSyncSessions } from "@/components/live-call";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/projects/$projectId/findings")({
  head: () => ({
    meta: [
      { title: "Research Findings — Diligence Live" },
      {
        name: "description",
        content:
          "Review expert evidence, investment thesis assessments and recommended next research rounds.",
      },
      { property: "og:title", content: "Research Findings — Diligence Live" },
      {
        property: "og:description",
        content:
          "Review expert evidence, investment thesis assessments and recommended next research rounds.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: FindingsPage,
});

export const sourceName = (p: DiligenceProject, f: Finding) => {
  const iv = allInterviews(p).find((i) => i.id === f.interviewId);
  return iv ? expertOf(p, iv.expertId) : undefined;
};

function FindingsPage() {
  const { projectId } = Route.useParams();
  const { project, update } = useProject(projectId);
  const navigate = useNavigate();
  const { clear: clearRound } = useRoundView();
  // Pick up live calls that finished while their sheet was closed.
  const syncIv = useCallback(
    (id: string, fn: (iv: Interview) => Interview) =>
      update((p) => ({ ...p, interviews: p.interviews.map((i) => (i.id === id ? fn(i) : i)) })),
    [update],
  );
  useSyncSessions(project, syncIv);
  if (!project) return null;
  const r = generateMockFindings(project);
  // Opening Findings means the consultant is done; one finished interview is enough.
  const anyDone = project.interviews.some((i) => i.status === "Completed");
  const roundNo = (project.pastRounds?.length ?? 0) + 1;

  if (!r.findings.length && !anyDone)
    return (
      <EmptyState
        icon={<FileText />}
        title="No findings yet"
        description="Findings open as soon as one interview has finished. Send an interview from Live Research."
        action={
          <Link to="/projects/$projectId/live" params={{ projectId }} className={buttonVariants()}>
            Open Live Research
          </Link>
        }
      />
    );

  return (
    <div className="space-y-10">
      <div className="flex items-center gap-2">
        <Badge tone="primary">Thesis validation and research gaps by GPT-6 from completed interviews</Badge>
        {roundNo > 1 && <Badge tone="outline">Consolidated across all research rounds</Badge>}
      </div>

      <LlmFindings
        project={project}
        update={update}
        nextRound={
          canRecommendNextRound(project) ? (
            <NextRoundCard
              project={project}
              update={update}
              onCreated={() => {
                clearRound(projectId);
                navigate({ to: "/projects/$projectId/plan", params: { projectId } });
              }}
            />
          ) : null
        }
      />

    </div>
  );
}

/**
 * "Recommended next round", written by GPT-6 from all the context so far
 * (lib/next-round.ts): sharper hypotheses, who to interview (existing contacts
 * or new profiles to recruit) and their questions.
 */
function NextRoundCard({
  project,
  update,
  onCreated,
}: {
  project: DiligenceProject;
  update: (fn: (p: DiligenceProject) => DiligenceProject) => void;
  onCreated: () => void;
}) {
  const n = useNextRound(project, update);
  const roundNo = (project.pastRounds?.length ?? 0) + 2;
  const existing = allHypotheses(project);
  const proposal = n.proposal;
  const person = (id: string) =>
    project.experts.find((e) => e.id === id) ?? proposal?.newExperts.find((e) => e.id === id);
  const isNew = (id: string) => !!proposal?.newExperts.some((e) => e.id === id);

  return (
    <section>
      <SectionTitle
        title="Recommended next round"
        description={
          proposal
            ? `By ${proposal.model} from the thesis, the findings, the research gaps and every transcript so far.`
            : `GPT-6 proposes Round ${roundNo}: what to test next, who to interview, and what to ask.`
        }
        action={
          <Button variant="secondary" size="sm" disabled={n.loading} onClick={() => void n.run()}>
            {n.loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {n.loading ? "Proposing…" : proposal ? "Propose again" : "Propose"}
          </Button>
        }
      />
      {n.error && !n.loading && <p className="mb-3 text-sm text-destructive">Proposal failed: {n.error}</p>}
      {n.loading && (
        <Card className="space-y-3 p-5">
          <p className="flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin text-primary" />
            GPT-6 is planning Round {roundNo} from everything so far…
          </p>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="animate-indeterminate h-full w-1/3 rounded-full bg-primary" />
          </div>
        </Card>
      )}
      {proposal && !n.loading && (
        <Card className="border-primary/30">
          <div className="space-y-5 p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Hypotheses to test in Round {roundNo}
            </p>
            {!proposal.plan.hypotheses.length && (
              <p className="text-sm text-muted-foreground">Nothing left to test: every hypothesis is supported.</p>
            )}
            {proposal.plan.hypotheses.map((h, i) => (
              <div key={h.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">H{existing.length + i + 1}</span>
                  <p className="font-medium">{h.title}</p>
                  {h.origin && (
                    <Badge tone={h.origin === "New" ? "warning" : "primary"} className="font-normal">
                      {h.origin}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{h.description}</p>
                {proposal.why[h.id] && (
                  <p className="mt-1 text-xs text-muted-foreground">Why: {proposal.why[h.id]}</p>
                )}
              </div>
            ))}

            <p className="pt-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Who to interview
            </p>
            {proposal.plan.experts.map((pe) => {
              const e = person(pe.expertId);
              return (
                <div key={pe.expertId} className="rounded-md border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{e?.name ?? "Interviewee"}</p>
                    <Badge tone={isNew(pe.expertId) ? "warning" : "neutral"} className="font-normal">
                      {isNew(pe.expertId) ? "New contact to recruit" : "From your contacts"}
                    </Badge>
                    <Badge tone="outline" className="font-normal">
                      {pe.audience === "customer" ? "Customer" : "Industry expert"}
                    </Badge>
                  </div>
                  {(e?.title || e?.description) && (
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {[e?.title, e?.description].filter(Boolean).join(" — ")}
                    </p>
                  )}
                  {pe.reason && <p className="mt-2 text-sm">{pe.reason}</p>}
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                    {pe.questions.map((q) => (
                      <li key={q.id}>{q.text}</li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-4 border-t bg-primary-soft/50 px-5 py-4">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Compass className="size-4 text-primary" /> New people are added to your contacts. You can
              edit everything in the Round {roundNo} plan before approving.
            </p>
            <Button
              disabled={!proposal.plan.experts.length}
              onClick={() => {
                update((p) => startNextRoundFrom(p, proposal));
                onCreated();
              }}
            >
              Create Round {roundNo} Plan <ArrowRight />
            </Button>
          </div>
        </Card>
      )}
    </section>
  );
}

/**
 * Investment thesis validation, written by GPT-6 from the project's thesis and
 * the transcripts of completed interviews (lib/thesis-validation.ts). Quotes are
 * verbatim from the transcripts; the backend drops any that are not.
 */
/**
 * Thesis validation and research gaps, both from one GPT-6 call. Nothing
 * pre-generated is shown: while GPT-6 works there is only a loading bar.
 */
function LlmFindings({
  project,
  update,
  nextRound,
}: {
  project: DiligenceProject;
  update: (fn: (p: DiligenceProject) => DiligenceProject) => void;
  /** The "Recommended next round" card; shown only with a finished GPT-6 result. */
  nextRound: ReactNode;
}) {
  const v = useThesisValidation(project, update);
  const working = v.loading || (v.hasEvidence && v.stale && !v.error);
  return (
    <>
      <ThesisValidationSection project={project} v={v} working={working} />
      {!working && v.result && <ResearchGapsSection project={project} result={v.result} />}
      {!working && v.result && nextRound}
    </>
  );
}

function ThesisValidationSection({
  project,
  v,
  working,
}: {
  project: DiligenceProject;
  v: ReturnType<typeof useThesisValidation>;
  working: boolean;
}) {
  const hyps = allHypotheses(project);
  const ivs = allInterviews(project);
  const who = (interviewId: string) => {
    const iv = ivs.find((i) => i.id === interviewId);
    return iv ? expertOf(project, iv.expertId)?.name ?? "Interviewee" : "Interviewee";
  };
  const r = v.result;

  return (
    <section>
      <SectionTitle
        title="Investment thesis validation"
        description={
          r
            ? `By ${r.model} from ${r.interviewCount} completed interview${r.interviewCount === 1 ? "" : "s"} · ${new Date(r.at).toLocaleString()}${v.stale ? " · out of date" : ""}`
            : "GPT-6 tests each hypothesis against the transcripts of completed interviews."
        }
        action={
          <Button variant="secondary" size="sm" disabled={working || !v.hasEvidence} onClick={() => void v.run()}>
            {v.loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {v.loading ? "Analysing…" : r ? "Re-run" : "Run"}
          </Button>
        }
      />
      {project.thesis && <ThesisText thesis={project.thesis} />}
      {v.error && <p className="mb-3 text-sm text-destructive">Validation failed: {v.error}</p>}
      {!v.hasEvidence && (
        <Card className="p-5 text-sm text-muted-foreground">
          No completed interview with a transcript yet. Finish an interview to validate the thesis.
        </Card>
      )}
      {working && <ThinkingBar project={project} />}
      {r && !working && (
        <div className="space-y-4">
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/60 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Hypothesis</th>
                  <th className="px-5 py-2.5 font-medium">Assessment</th>
                  <th className="px-5 py-2.5 font-medium">Key evidence</th>
                  <th className="px-5 py-2.5 font-medium">Sources</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {r.hypotheses.map((h) => {
                  const idx = hyps.findIndex((x) => x.id === h.id);
                  const hyp = hyps[idx];
                  return (
                    <tr key={h.id} className="align-top">
                      <td className="px-5 py-3 font-medium">
                        <span className="mr-2 font-mono text-xs text-muted-foreground">H{idx + 1}</span>
                        {hyp?.title ?? h.id}
                      </td>
                      <td className="px-5 py-3">
                        <AssessmentBadge value={h.assessment} />
                        <p className="mt-1.5 text-xs text-muted-foreground">{h.confidence} confidence</p>
                      </td>
                      <td className="px-5 py-3">
                        <p>{h.rationale}</p>
                        {h.evidence.map((e, k) => (
                          <blockquote
                            key={k}
                            className={cn(
                              "mt-2 border-l-2 pl-3 text-muted-foreground",
                              e.stance === "support"
                                ? "border-success"
                                : e.stance === "contradict"
                                  ? "border-destructive"
                                  : "border-border",
                            )}
                          >
                            &ldquo;{e.quote}&rdquo; <span className="text-xs">— {who(e.interviewId)}</span>
                          </blockquote>
                        ))}
                      </td>
                      <td className="px-5 py-3 text-muted-foreground">
                        {[...new Set(h.evidence.map((e) => who(e.interviewId)))].join(", ") || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
          {r.droppedQuotes > 0 && (
            <p className="text-xs text-muted-foreground">
              {r.droppedQuotes} quote{r.droppedQuotes === 1 ? "" : "s"} left out because {r.droppedQuotes === 1 ? "it was" : "they were"} not
              found word for word in the transcripts.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** Research gaps from the same GPT-6 call as the validation (so the two never disagree). */
function ResearchGapsSection({
  project,
  result,
}: {
  project: DiligenceProject;
  result: NonNullable<DiligenceProject["thesisValidation"]>;
}) {
  const hyps = allHypotheses(project);
  const label = (id: string | null) => {
    if (!id) return "Overall thesis";
    const i = hyps.findIndex((h) => h.id === id);
    return i >= 0 ? `H${i + 1} · ${hyps[i]?.title ?? ""}` : "Overall thesis";
  };
  return (
    <section>
      <SectionTitle
        title="Research gaps"
        description="What the completed interviews have not established yet, and what to do next."
      />
      <Card className="divide-y text-sm">
        {result.gaps.length ? (
          result.gaps.map((g, i) => (
            <div key={i} className="flex gap-3 px-4 py-3">
              <AlertTriangle
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  g.priority === "high"
                    ? "text-destructive"
                    : g.priority === "medium"
                      ? "text-warning"
                      : "text-muted-foreground",
                )}
              />
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  {label(g.hypothesisId)} · {g.priority} priority
                </p>
                <p>{g.gap}</p>
                {g.nextStep && (
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground">Next step: </span>
                    {g.nextStep}
                  </p>
                )}
              </div>
            </div>
          ))
        ) : (
          <p className="px-4 py-3 text-muted-foreground">No open gaps.</p>
        )}
      </Card>
    </section>
  );
}

/** An indeterminate progress bar with the elapsed time, while GPT-6 works. */
function ThinkingBar({ project }: { project: DiligenceProject }) {
  const [t0] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const n = allInterviews(project).filter((i) => i.status === "Completed" && i.transcript.length > 0).length;
  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin text-primary" />
          GPT-6 is reading {n} completed interview{n === 1 ? "" : "s"} against the thesis…
        </span>
        <span className="tabular-nums text-muted-foreground">{Math.floor((now - t0) / 1000)}s</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="animate-indeterminate h-full w-1/3 rounded-full bg-primary" />
      </div>
      <p className="text-xs text-muted-foreground">
        Thesis validation and research gaps appear here when it is done.
      </p>
    </Card>
  );
}

/** The thesis as its pillars (label in bold), or as written if it is free text. */
function ThesisText({ thesis }: { thesis: string }) {
  const pillars = thesisPillars(thesis);
  return (
    <Card className="mb-4 p-5 text-sm">
      <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Investment thesis
      </p>
      {pillars.length ? (
        <ul className="space-y-2">
          {pillars.map((p, i) => (
            <li key={i} className="flex gap-2">
              <span className="font-mono text-xs leading-5 text-muted-foreground">H{i + 1}</span>
              <span>
                <span className="font-medium">{p.label}:</span>{" "}
                <span className="text-muted-foreground">{p.text}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="whitespace-pre-line text-muted-foreground">{thesis}</p>
      )}
    </Card>
  );
}
