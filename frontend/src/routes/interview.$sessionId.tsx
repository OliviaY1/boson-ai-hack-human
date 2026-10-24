import { createFileRoute } from "@tanstack/react-router";
import { Clock, Mic, PhoneOff, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CallController, type CallState } from "@higgs/call/CallController";
import {
  AvatarView,
  formatDuration,
  useCallDuration,
  type InterviewSnapshot,
  type SharedCallConfig,
} from "@/components/live-call";
import { Badge, Button, Card } from "@/components/ui-kit";
import { cn } from "@/lib/utils";

/**
 * The interviewee's page: the link the consultant's "Send the interview" opens.
 *
 * The call runs HERE — this tab's microphone, Higgs Realtime, and the avatar's
 * sound — using the config the consultant stored on the backend. Its state is
 * published back (POST /api/interviews/:id/state) so the consultant's tab can
 * watch. The interviewee sees only the avatar and the transcript: no questions,
 * no dashboard.
 */
export const Route = createFileRoute("/interview/$sessionId")({
  head: () => ({ meta: [{ title: "Interview" }] }),
  component: IntervieweePage,
});

interface Loaded extends InterviewSnapshot {
  config: SharedCallConfig;
}

function IntervieweePage() {
  const { sessionId } = Route.useParams();
  const [info, setInfo] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState("");
  const [st, setSt] = useState<CallState | null>(null);
  const mediaRef = useRef<HTMLDivElement | null>(null);
  const ctrl = useRef<CallController | null>(null);
  const pending = useRef<CallState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const duration = useCallDuration(st);

  useEffect(() => {
    fetch(`/api/interviews/${sessionId}`)
      .then(async (res) => {
        const body = (await res.json()) as Loaded & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setInfo(body);
        // Reopening a finished interview shows how it ended.
        if (body.state?.phase === "ended") setSt(body.state);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [sessionId]);

  /** Send the call's state to the consultant (at most ~4 times a second; at once when it ends). */
  const publish = useCallback(
    (state: CallState) => {
      pending.current = state;
      const send = () => {
        timer.current = null;
        const s = pending.current;
        if (!s) return;
        void fetch(`/api/interviews/${sessionId}/state`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: s }),
          keepalive: s.phase === "ended",
        }).catch(() => undefined);
      };
      if (state.phase === "ended") {
        if (timer.current) clearTimeout(timer.current);
        send();
      } else if (!timer.current) {
        timer.current = setTimeout(send, 250);
      }
    },
    [sessionId],
  );

  // The consultant can end the call from their tab.
  useEffect(() => {
    const es = new EventSource(`/api/interviews/${sessionId}/events`);
    es.onmessage = (ev) => {
      const s = JSON.parse(ev.data as string) as InterviewSnapshot;
      if (s.endRequested) void ctrl.current?.stop();
    };
    return () => es.close();
  }, [sessionId]);

  useEffect(
    () => () => {
      const c = ctrl.current;
      ctrl.current = null;
      if (c) void c.stop().then(() => c.dispose());
    },
    [],
  );

  const start = useCallback(async () => {
    if (!info) return;
    const old = ctrl.current;
    if (old) await old.dispose();
    const c = new CallController({ ...info.config, mediaContainer: mediaRef.current }, (s) => {
      setSt(s);
      publish(s);
    });
    ctrl.current = c;
    await c.start();
  }, [info, publish]);

  const name = info?.display.interviewerName || info?.config.name || "Interviewer";
  const phase = st?.phase ?? "idle";
  const running = phase === "starting" || phase === "live";

  if (loadError) {
    return (
      <Shell>
        <Card className="p-8 text-center">
          <p className="font-semibold">This interview link can&apos;t be opened</p>
          <p className="mt-2 text-sm text-muted-foreground">{loadError}</p>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="mb-6">
        <p className="text-sm text-muted-foreground">
          {info?.display.company ? `About ${info.display.company}` : "Interview"}
        </p>
        <h1 className="text-2xl font-semibold">
          {info?.display.intervieweeName ? `Hi ${info.display.intervieweeName.split(" ")[0]}, ` : ""}
          {name} would like to ask you a few quick questions
        </h1>
      </div>

      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <div className="space-y-4">
          <AvatarView mediaRef={mediaRef} state={st} name={name} />
          {phase === "ended" ? (
            <Card className="p-4 text-center">
              <p className="font-medium">Interview finished</p>
              {duration !== null && (
                <p className="mt-1 inline-flex items-center gap-1 text-sm text-muted-foreground tabular-nums">
                  <Clock className="size-3.5" /> Total length {formatDuration(duration)}
                </p>
              )}
              <p className="mt-2 text-sm text-muted-foreground">Thank you for your time.</p>
            </Card>
          ) : running ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Badge tone={phase === "live" ? "success" : "warning"} dot={phase === "live" ? "pulse" : true}>
                  {phase === "starting"
                    ? "Connecting…"
                    : st?.activity === "speaking"
                      ? `${name} is speaking`
                      : st?.activity === "thinking"
                        ? `${name} is thinking`
                        : "Listening — go ahead"}
                </Badge>
                {duration !== null && (
                  <span className="text-sm tabular-nums text-muted-foreground">{formatDuration(duration)}</span>
                )}
              </div>
              {st?.micActive && (
                <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Mic className="size-3.5" /> Your microphone is on. You can interrupt at any time.
                </p>
              )}
              <Button variant="secondary" className="w-full" onClick={() => void ctrl.current?.stop()}>
                <PhoneOff /> Leave interview
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Button size="lg" className="w-full" disabled={!info} onClick={() => void start()}>
                <Play /> Start interview
              </Button>
              <p className="text-xs text-muted-foreground">
                Your browser will ask to use the microphone. The interview takes about a minute.
              </p>
            </div>
          )}
          {st?.error && <p className="text-sm text-destructive">{st.error}</p>}
        </div>

        <Card className="min-h-[24rem] p-5">
          <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Transcript
          </p>
          <Transcript state={st} name={name} />
        </Card>
      </div>
    </Shell>
  );
}

function Transcript({ state, name }: { state: CallState | null; name: string }) {
  const end = useRef<HTMLDivElement>(null);
  const turns = state?.transcript ?? [];
  // Block body on purpose: whatever an effect returns is called as its cleanup, and
  // scrollIntoView may return a value (a promise in newer browsers).
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [turns.length]);
  if (!turns.length)
    return <p className="py-8 text-center text-sm text-muted-foreground">The conversation will appear here.</p>;
  const t0 = state?.startedAt ?? turns[0]?.at ?? 0;
  return (
    <div className="space-y-4">
      {turns.map((t) => (
        <div key={t.id} className="animate-fade-up">
          <div className="mb-0.5 flex items-center gap-2 text-xs">
            <span className={cn("font-semibold", t.speaker === "alexa" ? "text-primary" : "text-foreground")}>
              {t.speaker === "alexa" ? name : "You"}
            </span>
            <span className="font-mono text-muted-foreground">{formatDuration(t.at - t0)}</span>
          </div>
          <p className="text-[15px] leading-relaxed">
            {t.text}
            {t.interrupted ? " —" : ""}
          </p>
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl px-6 py-10">{children}</div>
    </div>
  );
}
