import { Mic, PhoneCall, PhoneOff, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { CallController, type CallState } from "@higgs/call/CallController";
import type { Audience } from "@higgs/call/script";
import { Badge, Button, Select } from "@/components/ui-kit";
import { fillPlaceholders, interviewerName, useAlexaSettings } from "@/lib/alexa-settings";
import type { DiligenceProject, Interview, InterviewQuestion, TranscriptTurn } from "@/lib/types";

/**
 * A real voice call for one interview: the interviewer (Higgs Realtime, optionally with a
 * Higgs Avatar) calls the interviewee, and Claude keeps the question list up
 * to date while they talk. The call itself lives in the shared
 * CallController (src/call/ at the repo root, also used by the debug page);
 * this hook mirrors its state into the interview, so the transcript and the
 * question list on the page are the live ones.
 *
 * For the MVP demo, the person "picking up" is whoever is at this browser's
 * microphone.
 */

type SetIv = (id: string, fn: (iv: Interview) => Interview) => void;

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function goalFor(project: DiligenceProject, iv: Interview): string {
  const pe = project.plan?.experts.find((e) => e.expertId === iv.expertId);
  const hyps = (project.plan?.hypotheses ?? [])
    .filter((h) => pe?.hypothesisIds.includes(h.id))
    .map((h) => h.title);
  return [
    `Private equity diligence on ${project.company}.`,
    project.thesis ? `Investment thesis: ${project.thesis}` : "",
    pe?.objectives ? `Interview objectives: ${pe.objectives}` : "",
    hyps.length ? `Hypotheses to test: ${hyps.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The call's state, written into the interview the dashboard already renders. */
function mirror(iv: Interview, st: CallState, startedAt: number, kept: InterviewQuestion[]): Interview {
  const questions = st.questions.map((q): InterviewQuestion => {
    const out: InterviewQuestion = {
      id: q.id,
      text: q.text,
      status: q.status === "said" ? "answered" : q.status === "next" ? "current" : "pending",
    };
    if (q.added) out.added = true;
    if (q.status === "removed") out.removed = true;
    return out;
  });
  const transcript = st.transcript.map(
    (t): TranscriptTurn => ({
      id: t.id,
      speaker: t.speaker === "alexa" ? "ai" : "expert",
      text: t.interrupted ? `${t.text} —` : t.text,
      time: fmt(t.at - startedAt),
    }),
  );
  const ended = st.phase === "ended";
  return {
    ...iv,
    live: !ended,
    status: ended ? "Completed" : "In Progress",
    topic: ended ? "Interview complete" : "Live call",
    questions: [...kept, ...questions],
    transcript,
  };
}

export function useLiveCall(project: DiligenceProject, iv: Interview, setIv: SetIv) {
  const { settings, hydrated } = useAlexaSettings();
  const name = interviewerName(settings);
  const [state, setState] = useState<CallState | null>(null);
  // Default to who Claude judged this person to be when it wrote the plan.
  const planned = project.plan?.experts.find((e) => e.expertId === iv.expertId)?.audience;
  const [audience, setAudience] = useState<Audience>(planned ?? "expert");
  const mediaRef = useRef<HTMLDivElement | null>(null);
  const ctrl = useRef<CallController | null>(null);
  const latest = useRef<CallState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAt = useRef(0);
  const kept = useRef<InterviewQuestion[]>([]);
  const ivId = iv.id;

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const st = latest.current;
    if (st) setIv(ivId, (i) => mirror(i, st, startedAt.current, kept.current));
  }, [ivId, setIv]);

  const onChange = useCallback(
    (st: CallState) => {
      setState(st);
      latest.current = st;
      // Mirror into the store at most ~4 times a second (it is saved to localStorage),
      // but at once when the call ends.
      if (st.phase === "ended") flush();
      else if (!timer.current) timer.current = setTimeout(flush, 250);
    },
    [flush],
  );

  const start = useCallback(async () => {
    if (ctrl.current) await ctrl.current.dispose();
    const open = iv.questions.filter((q) => q.status !== "answered" && !q.removed);
    kept.current = iv.questions.filter((q) => q.status === "answered" && !q.removed);
    startedAt.current = Date.now();
    const c = new CallController(
      {
        name,
        instructions: fillPlaceholders(settings.instructions, name, project.company),
        closing: fillPlaceholders(settings.closing, name, project.company),
        goal: goalFor(project, iv),
        audience,
        questions: open.map((q) => q.text),
        avatarId: settings.avatarId || null,
        mediaContainer: mediaRef.current,
      },
      onChange,
    );
    ctrl.current = c;
    setIv(ivId, (i) => ({ ...i, live: true, status: "In Progress", topic: "Live call", transcript: [] }));
    await c.start();
  }, [audience, iv, ivId, name, onChange, project, setIv, settings]);

  const stop = useCallback(async () => {
    await ctrl.current?.stop();
  }, []);

  // Leaving the interview ends the call.
  useEffect(
    () => () => {
      const c = ctrl.current;
      ctrl.current = null;
      if (c) void c.stop().then(() => c.dispose());
    },
    [],
  );

  const running = state?.phase === "starting" || state?.phase === "live";
  return { state, running, start, stop, audience, setAudience, mediaRef, ready: hydrated, name };
}

export type LiveCall = ReturnType<typeof useLiveCall>;

/** Start / end the call, plus what it is doing right now. */
export function LiveCallBar({ call }: { call: LiveCall }) {
  const st = call.state;
  const phase = st?.phase ?? "idle";
  const doing =
    phase === "starting"
      ? "Connecting…"
      : phase === "live"
        ? st?.activity === "speaking"
          ? `${call.name} is speaking`
          : st?.activity === "thinking"
            ? `${call.name} is thinking`
            : "Listening"
        : phase === "ended"
          ? "Call ended"
          : "Not connected";
  return (
    <div className="flex flex-wrap items-center gap-3 border-b bg-muted/30 px-6 py-3">
      <Badge tone={phase === "live" ? "success" : phase === "starting" ? "warning" : "neutral"} dot={phase === "live" ? "pulse" : true}>
        Live call · {doing}
      </Badge>
      {phase === "live" && st?.micActive && (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Mic className="size-3.5" /> microphone on
        </span>
      )}
      {st && st.claude.status !== "idle" ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Sparkles className="size-3.5" />
          {st.claude.status === "updating" ? "Claude is updating questions…" : `Claude: ${st.claude.detail}`}
        </span>
      ) : (
        st?.claude.detail && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Sparkles className="size-3.5" /> last update {st.claude.detail}
          </span>
        )
      )}
      <div className="ml-auto flex items-center gap-2">
        <Select
          aria-label="Interviewee"
          value={call.audience}
          disabled={call.running}
          onChange={(e) => call.setAudience(e.target.value as Audience)}
        >
          <option value="expert">Industry expert</option>
          <option value="customer">Customer</option>
        </Select>
        {call.running ? (
          <Button variant="destructive" size="sm" onClick={() => void call.stop()}>
            <PhoneOff /> End call
          </Button>
        ) : (
          <Button size="sm" disabled={!call.ready} onClick={() => void call.start()}>
            <PhoneCall /> {phase === "ended" ? "Call again" : "Start live call"}
          </Button>
        )}
      </div>
      {st?.error && <p className="w-full text-sm text-destructive">{st.error}</p>}
    </div>
  );
}

/** The avatar's video (the element itself is added by AvatarLink). */
export function AvatarView({
  mediaRef,
  state,
  name,
}: {
  mediaRef: RefObject<HTMLDivElement | null>;
  state: CallState | null;
  name: string;
}) {
  const a = state?.avatar;
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{name}</p>
      <div
        ref={mediaRef}
        className="relative aspect-[3/4] w-full overflow-hidden rounded-md border bg-muted [&_video]:h-full [&_video]:w-full [&_video]:object-cover"
      >
        {(!a || a.status !== "live") && (
          <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted-foreground">
            {!a || a.status === "off"
              ? "The avatar appears here once a live call starts."
              : a.status === "starting"
                ? "Starting the avatar…"
                : a.status === "error"
                  ? `Avatar unavailable: ${a.detail}`
                  : "Avatar ended."}
          </p>
        )}
      </div>
    </div>
  );
}
