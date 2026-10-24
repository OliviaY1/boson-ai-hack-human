import { Clock, ExternalLink, Mic, PhoneOff, Send, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { CallConfig, CallState } from "@higgs/call/CallController";
import type { Audience } from "@higgs/call/script";
import { Badge, Button, Select } from "@/components/ui-kit";
import { fillPlaceholders, interviewerName, useAlexaSettings } from "@/lib/alexa-settings";
import type { DiligenceProject, Interview, InterviewQuestion, TranscriptTurn } from "@/lib/types";

/**
 * The consultant's side of a live interview.
 *
 * The call itself runs in the INTERVIEWEE's tab (routes/interview.$sessionId.tsx):
 * their microphone, Higgs Realtime, and the avatar's sound. The consultant
 * "sends the interview" — the call's config goes to the backend
 * (POST /api/interviews) and the interviewee's link opens in a new tab — and
 * then watches it live over Server-Sent Events: transcript, the question list
 * as Claude changes it, and the duration. The avatar is shown only to the
 * interviewee; this tab has neither its video nor its sound. The consultant
 * can end the call from here.
 */

type SetIv = (id: string, fn: (iv: Interview) => Interview) => void;

/** What GET /api/interviews/:id/events sends. */
export interface InterviewSnapshot {
  id: string;
  createdAt: number;
  display: { interviewerName?: string; intervieweeName?: string; company?: string };
  state: CallState | null;
  endRequested: boolean;
}

/** The config the interviewee's tab runs (CallController's, without the DOM node). */
export type SharedCallConfig = Omit<CallConfig, "mediaContainer">;

export const formatDuration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export const interviewLink = (id: string) =>
  typeof window === "undefined" ? `/interview/${id}` : `${window.location.origin}/interview/${id}`;

/** Elapsed call time: live while it runs, fixed once it ended. */
export function useCallDuration(st: CallState | null): number | null {
  const [now, setNow] = useState(Date.now());
  const running = !!st?.startedAt && !st.endedAt;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);
  if (!st?.startedAt) return null;
  return (st.endedAt ?? now) - st.startedAt;
}

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
export function mirror(iv: Interview, st: CallState): Interview {
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
  const t0 = st.startedAt ?? st.transcript[0]?.at ?? Date.now();
  const transcript = st.transcript.map(
    (t): TranscriptTurn => ({
      id: t.id,
      speaker: t.speaker === "alexa" ? "ai" : "expert",
      text: t.interrupted ? `${t.text} —` : t.text,
      time: formatDuration(t.at - t0),
    }),
  );
  const ended = st.phase === "ended";
  const running = st.phase === "live" || st.phase === "starting";
  return {
    ...iv,
    live: running,
    status: ended ? "Completed" : running ? "In Progress" : iv.status,
    topic: ended
      ? `Interview complete${st.startedAt && st.endedAt ? ` · ${formatDuration(st.endedAt - st.startedAt)}` : ""}`
      : running
        ? "Live call"
        : iv.topic,
    questions: questions.length ? questions : iv.questions,
    transcript: st.transcript.length || ended ? transcript : iv.transcript,
  };
}

export function useLiveCall(project: DiligenceProject, iv: Interview, setIv: SetIv) {
  const { settings, hydrated } = useAlexaSettings();
  const name = interviewerName(settings);
  // Default to who Claude judged this person to be when it wrote the plan.
  const planned = project.plan?.experts.find((e) => e.expertId === iv.expertId)?.audience;
  const [audience, setAudience] = useState<Audience>(planned ?? "expert");
  const [snap, setSnap] = useState<InterviewSnapshot | null>(null);
  const [error, setError] = useState("");
  const latest = useRef<CallState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ivId = iv.id;
  const sessionId = iv.sessionId;

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const st = latest.current;
    if (st) setIv(ivId, (i) => mirror(i, st));
  }, [ivId, setIv]);

  // Watch the session: the interviewee's tab publishes, the backend relays here.
  useEffect(() => {
    if (!sessionId) return;
    setError("");
    const es = new EventSource(`/api/interviews/${sessionId}/events`);
    es.onmessage = (ev) => {
      const s = JSON.parse(ev.data as string) as InterviewSnapshot;
      setSnap(s);
      const st = s.state;
      if (!st) return;
      latest.current = st;
      // Mirror into the store (saved to localStorage) at most ~4 times a second,
      // but at once when the call ends.
      if (st.phase === "ended") flush();
      else if (!timer.current) timer.current = setTimeout(flush, 250);
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setError("Lost the interview session (the server may have restarted). Send the interview again.");
      }
    };
    return () => es.close();
  }, [sessionId, flush]);

  /**
   * Create the session and open the interviewee's tab. The tab is opened inside
   * the click (blank first) so the browser does not block it as a popup.
   */
  const send = useCallback(async () => {
    setError("");
    const tab = typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
    const config: SharedCallConfig = {
      name,
      instructions: fillPlaceholders(settings.instructions, name, project.company),
      closing: fillPlaceholders(settings.closing, name, project.company),
      goal: goalFor(project, iv),
      audience,
      // Every interview starts fresh: all questions except ones Claude removed before.
      questions: iv.questions.filter((q) => !q.removed).map((q) => q.text),
      avatarId: settings.avatarId || null,
    };
    const person = project.experts.find((e) => e.id === iv.expertId);
    try {
      const res = await fetch("/api/interviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config,
          display: { interviewerName: name, intervieweeName: person?.name ?? "", company: project.company },
        }),
      });
      const body = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !body.id) throw new Error(body.error ?? `HTTP ${res.status}`);
      const id = body.id;
      latest.current = null;
      setSnap(null);
      setIv(ivId, (i) => ({
        ...i,
        sessionId: id,
        live: false,
        status: "Not Started",
        topic: "Invited",
        transcript: [],
        questions: i.questions
          .filter((q) => !q.removed)
          .map((q): InterviewQuestion => ({ id: q.id, text: q.text, status: "pending" })),
      }));
      if (tab) tab.location.href = interviewLink(id);
      else window.open(interviewLink(id), "_blank");
    } catch (e) {
      tab?.close();
      setError(`Could not create the interview: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [audience, iv, ivId, name, project, setIv, settings]);

  const end = useCallback(async () => {
    if (!sessionId) return;
    await fetch(`/api/interviews/${sessionId}/end`, { method: "POST" }).catch(() => undefined);
  }, [sessionId]);

  const state = snap?.state ?? null;
  const running = state?.phase === "starting" || state?.phase === "live";
  return {
    state,
    running,
    sessionId,
    link: sessionId ? interviewLink(sessionId) : "",
    send,
    end,
    error,
    audience,
    setAudience,
    ready: hydrated,
    name,
  };
}

export type LiveCall = ReturnType<typeof useLiveCall>;

/** Send the interview, the interviewee's link, what is happening, and how long it took. */
export function LiveCallBar({ call }: { call: LiveCall }) {
  const st = call.state;
  const phase = st?.phase ?? "idle";
  const duration = useCallDuration(st);
  const doing = !call.sessionId
    ? "Not sent yet"
    : phase === "idle"
      ? "Waiting for the interviewee to start"
      : phase === "starting"
        ? "Connecting…"
        : phase === "live"
          ? st?.activity === "speaking"
            ? `${call.name} is speaking`
            : st?.activity === "thinking"
              ? `${call.name} is thinking`
              : "Listening to the interviewee"
          : "Interview finished";
  return (
    <div className="space-y-2 border-b bg-muted/30 px-6 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <Badge
          tone={phase === "live" ? "success" : phase === "starting" ? "warning" : "neutral"}
          dot={phase === "live" ? "pulse" : true}
        >
          Live interview · {doing}
        </Badge>
        {duration !== null && (
          <span className="inline-flex items-center gap-1 text-xs font-medium tabular-nums">
            <Clock className="size-3.5" />
            {phase === "ended" ? `Total ${formatDuration(duration)}` : formatDuration(duration)}
          </span>
        )}
        {phase === "live" && st?.micActive && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Mic className="size-3.5" /> interviewee&apos;s microphone on
          </span>
        )}
        {st && (st.claude.status !== "idle" || st.claude.detail) && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Sparkles className="size-3.5" />
            {st.claude.status === "updating"
              ? "Claude is updating questions…"
              : st.claude.status === "error"
                ? `Claude: ${st.claude.detail}`
                : `last update ${st.claude.detail}`}
          </span>
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
            <Button variant="destructive" size="sm" onClick={() => void call.end()}>
              <PhoneOff /> End call
            </Button>
          ) : (
            <Button size="sm" disabled={!call.ready} onClick={() => void call.send()}>
              <Send /> {call.sessionId ? "Send the interview again" : "Send the interview"}
            </Button>
          )}
        </div>
      </div>
      {call.link && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          Interviewee link:
          <a className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline" href={call.link} target="_blank" rel="noreferrer">
            {call.link} <ExternalLink className="size-3" />
          </a>
        </p>
      )}
      {(call.error || st?.error) && <p className="text-sm text-destructive">{call.error || st?.error}</p>}
    </div>
  );
}

/** The avatar on the interviewee's page (the video element itself is added by AvatarLink). */
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
      <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {name}
      </p>
      <div className="relative mx-auto aspect-[3/4] w-full max-w-[220px] overflow-hidden rounded-md border bg-muted">
        {/* The avatar code appends its <video>/<audio> here. React renders nothing inside
            this node, so the two never touch the same children. */}
        <div
          ref={mediaRef}
          className="absolute inset-0 [&_video]:h-full [&_video]:w-full [&_video]:object-cover"
        />
        {(!a || a.status !== "live") && (
          <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted-foreground">
            {!a || a.status === "off"
              ? "The avatar appears here once the interview starts."
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

/**
 * Keep interviews with a live session up to date even when their sheet is not
 * open: the backend has each call's latest state, so the Live Research and
 * Findings pages read it (every few seconds while a call is unfinished) and
 * mirror it in — a call that ended while the sheet was closed still counts.
 */
export function useSyncSessions(
  project: DiligenceProject | undefined,
  setIv: (id: string, fn: (iv: Interview) => Interview) => void,
) {
  const pending = (project?.interviews ?? [])
    .filter((iv) => iv.sessionId && iv.status !== "Completed")
    .map((iv) => `${iv.id}:${iv.sessionId}`)
    .join(",");
  useEffect(() => {
    if (!pending) return;
    let stop = false;
    const sync = async () => {
      for (const pair of pending.split(",")) {
        const [ivId, sessionId] = pair.split(":");
        if (!ivId || !sessionId) continue;
        try {
          const res = await fetch(`/api/interviews/${sessionId}`);
          if (!res.ok) continue;
          const s = (await res.json()) as InterviewSnapshot;
          const st = s.state;
          if (!stop && st && (st.phase === "ended" || st.transcript.length)) setIv(ivId, (i) => mirror(i, st));
        } catch {
          /* backend not reachable right now; try again on the next tick */
        }
      }
    };
    void sync();
    const t = setInterval(() => void sync(), 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [pending, setIv]);
}
