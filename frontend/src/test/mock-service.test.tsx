import { describe, expect, it } from "vitest";
import { OAKVILLE_THESIS, seedProjects } from "@/lib/mock-data";
import type { DiligenceProject, ThesisValidationResult } from "@/lib/types";
import {
  addInterviewQuestion,
  advanceMockInterview,
  createInterviewsFromPlan,
  generateMockResearchPlan,
  hypothesesFromThesis,
  missingSamples,
  startMockInterview,
  withoutProject,
  generateNextRoundPlan,
  allHypotheses,
} from "@/lib/mock-service";

const david = () =>
  startMockInterview(seedProjects()[0]!.interviews.find((i) => i.expertId === "e-david")!);

describe("interview simulation", () => {
  it("consultant follow-up is asked before remaining planned questions", () => {
    let iv = addInterviewQuestion(
      david(),
      "Are staffing shortages causing appointment cancellations?",
    );
    iv = advanceMockInterview(iv); // AI asks the follow-up
    expect(iv.transcript.at(-1)?.text).toContain("staffing shortages");
    iv = advanceMockInterview(iv); // expert answers
    expect(iv.findings.map((f) => f.id)).toContain("f-link");
  });

  it("interview completes after all questions answered", () => {
    let iv = david();
    for (let i = 0; i < 11; i++) iv = advanceMockInterview(iv);
    expect(iv.status).toBe("Completed");
  });
});

import {
  advanceMockInterview as adv,
  autoLaunchInterviews,
  canRecommendNextRound,
  completeMockInterview,
  generateMockFindings,
  pauseMockInterview,
  startNextRound,
} from "@/lib/mock-service";

describe("research rounds", () => {
  it("shows evidence from completed custom interviews without claiming the thesis is supported", () => {
    const seed = seedProjects().find((p) => p.id === "harbor");
    if (!seed) throw new Error("Missing Harbor fixture");
    const project = { ...seed, selectedExpertIds: seed.experts.map((e) => e.id) };
    const plan = { ...generateMockResearchPlan(project), approved: true };
    let interviews = createInterviewsFromPlan(plan).map(startMockInterview);
    for (let k = 0; k < 12; k++) interviews = interviews.map(advanceMockInterview);
    expect(interviews.every((iv) => iv.status === "Completed")).toBe(true);
    expect(interviews.flatMap((iv) => iv.findings)).toHaveLength(0);
    const done = { ...project, plan, interviews };
    const results = generateMockFindings(done);
    // Harbor has one AlphaSights expert (Priya Raman) since the directory was cut to four.
    expect(results.findings).toHaveLength(4);
    expect(results.findings.every((f) => f.sentiment === "neutral")).toBe(true);
    expect(results.validation.every((v) => v.assessment === "Insufficient Evidence")).toBe(true);
    for (const finding of results.findings) {
      const iv = interviews.find((i) => i.id === finding.interviewId);
      expect(iv?.transcript.find((t) => t.id === finding.turnId)?.text).toBe(finding.quote);
    }
    expect(generateMockFindings(done)).toEqual(results);
    expect(generateMockFindings(startNextRound(done)).findings).toEqual(results.findings);
  });

  it("proposes Round 2 once an interview is completed, and keeps Round 1 findings", () => {
    const p = seedProjects()[0]!;
    expect(canRecommendNextRound(p)).toBe(false);
    const oneDone = { ...p, interviews: p.interviews.map((iv, k) => (k === 0 ? completeMockInterview(iv) : iv)) };
    expect(canRecommendNextRound(oneDone)).toBe(true);
    let ivs = p.interviews.map((i) => startMockInterview(i));
    for (let k = 0; k < 12; k++) ivs = ivs.map(adv);
    const done = { ...p, interviews: ivs.map(completeMockInterview) };
    expect(canRecommendNextRound(done)).toBe(true);
    const r2 = startNextRound(done);
    expect(r2.pastRounds).toHaveLength(1);
    expect(r2.plan!.hypotheses.map((h) => h.id)).toEqual(["h6", "h7"]);
    expect(r2.experts.some((e) => e.id === "e-linda")).toBe(true);
    expect(generateMockFindings(r2).findings.length).toBe(
      generateMockFindings(done).findings.length,
    );
  });
});

describe("automatic interview agents", () => {
  it("starts queued interviews on its own, two at a time, without a consultant pressing start", () => {
    const p = seedProjects()[0]!;
    expect(p.interviews.every((i) => i.status === "Not Started")).toBe(true);

    const started = autoLaunchInterviews(p);
    expect(started.interviews.filter((i) => i.status === "In Progress")).toHaveLength(2);
    expect(started.interviews.filter((i) => i.status === "Not Started")).toHaveLength(
      p.interviews.length - 2,
    );

    // A finished agent's slot is taken by the next queued interview.
    const oneDone = {
      ...started,
      interviews: started.interviews.map((i, idx) => (idx === 0 ? completeMockInterview(i) : i)),
    };
    expect(
      autoLaunchInterviews(oneDone).interviews.filter((i) => i.status === "In Progress"),
    ).toHaveLength(2);

    // A paused interview is never restarted by the scheduler.
    const paused = {
      ...started,
      interviews: started.interviews.map((i, idx) => (idx === 1 ? pauseMockInterview(i) : i)),
    };
    const afterPause = autoLaunchInterviews(paused);
    expect(afterPause.interviews.filter((i) => i.status === "Paused")).toHaveLength(1);
    expect(afterPause.interviews.filter((i) => i.status === "In Progress")).toHaveLength(2);
  });
});

describe("saved projects", () => {
  it("deleting one project leaves the others untouched", () => {
    const ps = seedProjects();
    expect(withoutProject(ps, "northstar").map((p) => p.id)).toEqual(["harbor", "summit", "oakville"]);
    expect(withoutProject(ps, "not-saved")).toHaveLength(ps.length);
  });

  it("offers sample projects only when they are not already saved", () => {
    const ps = seedProjects();
    expect(missingSamples(ps)).toHaveLength(0);
    expect(missingSamples([]).map((p) => p.id)).toEqual(["northstar", "harbor", "summit", "oakville"]);
    expect(missingSamples([ps[0]!]).map((p) => p.id)).toEqual(["harbor", "summit", "oakville"]);
  });
});

describe("hypotheses from the thesis", () => {
  it("turns each 'Label: We believe …' pillar of the Oakville thesis into a hypothesis", () => {
    const hs = hypothesesFromThesis(OAKVILLE_THESIS);
    expect(hs.map((h) => h.title)).toEqual([
      "Market Attractiveness",
      "Competitive Positioning",
      "Organic Revenue Growth",
      "Operational Efficiency",
      "Talent Retention",
      "Acquisition-Led Expansion",
      "Financial Returns",
    ]);
    expect(hs[0]!.description.startsWith("We believe Oakville's")).toBe(true);
  });

  it("falls back to the template for free-text theses", () => {
    expect(hypothesesFromThesis("A great company with strong growth.")).toEqual([]);
  });

  it("uses the pillars in a generated plan", () => {
    const p = seedProjects().find((x) => x.id === "oakville")!;
    const plan = generateMockResearchPlan({
      ...p,
      experts: [
        { id: "c1", name: "Olivia", title: "Custom contact", phone: "", description: "Dog owner", source: "Custom" },
      ],
    });
    expect(plan.hypotheses).toHaveLength(7);
    expect(plan.experts[0]!.hypothesisIds).toHaveLength(7);
  });
});

describe("recommended next round from GPT-6's findings", () => {
  // The Oakville demo after one live interview and a GPT-6 validation.
  function oakvilleAfterOneInterview(): DiligenceProject {
    const base = seedProjects().find((x) => x.id === "oakville")!;
    const contacts = [
      { id: "c-olivia", name: "Olivia Yan", title: "Custom contact", phone: "", description: "Dog owner in Oakville", source: "Custom" as const },
      { id: "c-mark", name: "Mark Chen", title: "Custom contact", phone: "", description: "Former practice manager, GTA vet clinic", source: "Custom" as const },
    ];
    const withContacts = { ...base, experts: contacts };
    const plan = { ...generateMockResearchPlan(withContacts), approved: true };
    const interviews = createInterviewsFromPlan(plan);
    interviews[0] = {
      ...interviews[0]!,
      status: "Completed",
      transcript: [
        { id: "t1", speaker: "ai", text: "How often do you visit the vet?", time: "00:01" },
        { id: "t2", speaker: "expert", text: "Twice a year, and the clinic is close to home.", time: "00:05" },
      ],
    };
    const [h1, h2, h3, h4, h5] = plan.hypotheses;
    const thesisValidation: ThesisValidationResult = {
      at: "2026-10-24T13:00:00Z",
      model: "gpt-6",
      inputKey: "k",
      interviewCount: 1,
      overall: { verdict: "Insufficient evidence", summary: "" },
      hypotheses: [
        { id: h1!.id, assessment: "Supported", confidence: "medium", rationale: "Regular visits.", evidence: [] },
        { id: h2!.id, assessment: "Insufficient Evidence", confidence: "low", rationale: "Only one customer.", evidence: [] },
        { id: h3!.id, assessment: "Mixed Evidence", confidence: "low", rationale: "Conflicting.", evidence: [] },
        { id: h4!.id, assessment: "Contradicted", confidence: "medium", rationale: "Costs rising.", evidence: [] },
        { id: h5!.id, assessment: "Insufficient Evidence", confidence: "low", rationale: "Not discussed.", evidence: [] },
      ],
      gaps: [
        { hypothesisId: h2!.id, gap: "No evidence on local market share.", nextStep: "Call a competing clinic owner; ask how share has moved.", priority: "high" },
        { hypothesisId: h4!.id, gap: "Cost savings unproven.", nextStep: "Ask a former practice manager about procurement costs.", priority: "medium" },
      ],
      droppedQuotes: 0,
    };
    return { ...withContacts, plan, interviews, selectedExpertIds: [], thesisValidation };
  }

  it("is offered once one interview is completed", () => {
    const p = oakvilleAfterOneInterview();
    expect(p.interviews.filter((i) => i.status === "Completed")).toHaveLength(1);
    expect(p.interviews.length).toBeGreaterThan(1);
    expect(canRecommendNextRound(p)).toBe(true);
    expect(canRecommendNextRound({ ...p, interviews: p.interviews.map((i) => ({ ...i, status: "Not Started" as const })) })).toBe(false);
  });

  it("targets up to 3 hypotheses GPT-6 did not find supported, with their gaps and next steps", () => {
    const p = oakvilleAfterOneInterview();
    const all = p.plan!.hypotheses;
    const { plan, newExperts } = generateNextRoundPlan(p);
    expect(plan.hypotheses).toHaveLength(3);
    // H1 was Supported, so the round starts at H2.
    expect(plan.hypotheses.map((h) => h.title)).toEqual([
      `Resolve: ${all[1]!.title}`,
      `Resolve: ${all[2]!.title}`,
      `Resolve: ${all[3]!.title}`,
    ]);
    expect(plan.hypotheses.map((h) => h.origin)).toEqual([
      "Refined from H2 · Insufficient Evidence",
      "Refined from H3 · Mixed Evidence",
      "Refined from H4 · Contradicted",
    ]);
    // Described with the research gap; "who to call and what to ask" is the gap's next step.
    expect(plan.hypotheses[0]!.description).toBe("No evidence on local market share.");
    expect(plan.hypotheses[0]!.evidence).toBe("Call a competing clinic owner; ask how share has moved.");
    // No gap for H3: falls back to GPT-6's rationale.
    expect(plan.hypotheses[1]!.description).toBe("Conflicting.");
    expect(plan.hypotheses.every((h) => h.round === 2)).toBe(true);
    // People come from the consultant's contacts; no network experts are added.
    expect(newExperts).toEqual([]);
    expect(plan.experts.map((e) => e.expertId).every((id) => p.experts.some((x) => x.id === id))).toBe(true);
    expect(plan.experts[0]!.questions).toHaveLength(3);
    expect(plan.approved).toBe(false);
  });

  it("Create Round 2 Plan archives round 1 and opens the new plan", () => {
    const p = oakvilleAfterOneInterview();
    const r2 = startNextRound(p);
    expect(r2.pastRounds).toHaveLength(1);
    expect(r2.pastRounds![0]!.interviews).toEqual(p.interviews);
    expect(r2.interviews).toEqual([]);
    expect(r2.plan!.approved).toBe(false);
    expect(r2.plan!.hypotheses[0]!.title.startsWith("Resolve: ")).toBe(true);
    // Round 1 evidence stays available to the Findings page.
    expect(allHypotheses(r2).length).toBe(p.plan!.hypotheses.length + 3);
    expect(canRecommendNextRound(r2)).toBe(false);
  });

  it("offers nothing to resolve when GPT-6 found every hypothesis supported", () => {
    const p = oakvilleAfterOneInterview();
    const allSupported = {
      ...p,
      thesisValidation: {
        ...p.thesisValidation!,
        hypotheses: p.thesisValidation!.hypotheses.map((h) => ({ ...h, assessment: "Supported" as const })),
      },
    };
    expect(generateNextRoundPlan(allSupported).plan.hypotheses).toEqual([]);
  });
});
