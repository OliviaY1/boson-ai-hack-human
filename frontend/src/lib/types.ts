export type ProjectStatus =
  "Draft" | "Planning" | "Ready for Interviews" | "In Progress" | "Completed";

export type ExpertSource = "GLG" | "AlphaSights" | "Third Bridge" | "Custom";

export interface Expert {
  id: string;
  name: string;
  title: string;
  phone: string;
  description: string;
  source: ExpertSource;
}

export interface ExpertNetwork {
  id: Exclude<ExpertSource, "Custom">;
  name: string;
  description: string;
  connected: boolean;
}

export interface InvestmentHypothesis {
  id: string;
  title: string;
  description: string;
  evidence: string;
  /** e.g. "New" or "Refined from H3" for hypotheses proposed after a research round. */
  origin?: string;
  /** Findings that prompted this hypothesis. */
  basisFindingIds?: string[];
  /** Research round in which the hypothesis was introduced (1 for the original thesis). */
  round?: number;
}

export interface PlanQuestion {
  id: string;
  text: string;
}

export interface PlanExpert {
  expertId: string;
  reason: string;
  hypothesisIds: string[];
  objectives: string;
  questions: PlanQuestion[];
  /** Who the person is, as Claude judged it; picks the live call's question style. */
  audience?: "customer" | "expert";
  /** Where the questions came from: Claude, or the built-in template (with why). */
  questionSource?: "claude" | "template";
  questionNote?: string;
}

export interface ResearchPlan {
  hypotheses: InvestmentHypothesis[];
  experts: PlanExpert[];
  approved: boolean;
}

export interface ResearchRound {
  plan: ResearchPlan;
  interviews: Interview[];
}

export type InterviewStatus = "Not Started" | "In Progress" | "Paused" | "Completed";

export interface InterviewQuestion {
  id: string;
  text: string;
  status: "pending" | "current" | "answered";
  added?: boolean;
  /** Dropped during a live call (Claude decided it no longer fits); kept for the record. */
  removed?: boolean;
}

export interface TranscriptTurn {
  id: string;
  speaker: "ai" | "expert";
  text: string;
  time: string;
  questionId?: string;
}

export interface Finding {
  id: string;
  title: string;
  description: string;
  hypothesisId: string;
  interviewId: string;
  turnId: string;
  quote: string;
  sentiment: "support" | "contradict" | "neutral";
}

export interface Interview {
  id: string;
  expertId: string;
  status: InterviewStatus;
  topic: string;
  questions: InterviewQuestion[];
  transcript: TranscriptTurn[];
  findings: Finding[];
  /** A real voice call (Higgs Realtime) is running; the demo simulation leaves it alone. */
  live?: boolean;
  /** The backend interview session the interviewee's link points at. */
  sessionId?: string;
}

export interface FindingReview {
  status?: "accepted" | "flagged" | undefined;
  note?: string | undefined;
}

export interface DiligenceProject {
  id: string;
  company: string;
  thesis: string;
  status: ProjectStatus;
  networks: ExpertNetwork[];
  experts: Expert[];
  plan?: ResearchPlan;
  interviews: Interview[];
  reviews: Record<string, FindingReview>;
  /** Network experts the consultant chose to include; custom experts are always included. */
  selectedExpertIds?: string[];
  /** Completed earlier research rounds; `plan` and `interviews` hold the current round. */
  pastRounds?: ResearchRound[];
  updatedAt: string;
}
