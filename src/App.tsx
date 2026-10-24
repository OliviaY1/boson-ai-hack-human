import { useCallback, useEffect, useRef, useState } from "react";
import {
  RealtimeClient,
  type Activity,
  type ConnectionState,
  type LogEntry,
} from "./realtime/RealtimeClient";
import {
  emptyTranscript,
  toPlainText,
  transcriptReducer,
  type TranscriptState,
} from "./state/transcriptStore";
import { SERVER } from "./realtime/events";
import { DebugDrawer } from "./ui/DebugDrawer";
import { MicButton } from "./ui/MicButton";
import { SessionPanel } from "./ui/SessionPanel";
import { VoiceEventsPanel } from "./ui/VoiceEventsPanel";
import { SpeechTimeline } from "./ui/SpeechTimeline";
import { LlmPanel, type LlmCall } from "./ui/LlmPanel";
import { QuestionList, type RemovedQuestion } from "./ui/QuestionList";
import { StatusBar } from "./ui/StatusBar";

/**
 * The default for the System instructions box. Higgs only replies after you
 * speak (server VAD starts each response), so the script is written as
 * replies to your turns.
 */
const DEFAULT_INSTRUCTIONS = `You are Alexa from a private equity firm. Say exactly: "Hi, I'm Alexa from a private equity firm. Do you have one minute for a few quick questions about Nike?" Nothing else.`;

/** One per line. Each is sent in its own session.update after you finish a turn. */
/** What the interview is for. Sent to Claude as context with every call. */
const DEFAULT_GOAL =
  "Private equity consumer research on Nike: which sports brands people buy and why, " +
  "how their Nike spending is changing, and, for people who don't buy Nike or sports " +
  "brands, why not.";

const DEFAULT_QUESTIONS = [
  "Which sports brand do you buy most?",
  "Why that brand?",
  "Are you buying more Nike this year, or less?",
].join("\n");

/** Sent in one more session.update after the answer to the last question. */
const DEFAULT_CLOSING = "That's all my questions. Thank you so much for your time, have a great day!";

/** The short instructions sent for each question. */
function questionInstructions(question: string): string {
  return `You are Alexa, a market researcher. Say exactly: "${question}" Nothing else.`;
}

/**
 * The step right after the greeting: the model itself decides whether the
 * person agreed. This is sent when the greeting ends, before they answer, so
 * the code cannot know their answer yet.
 */
function firstQuestionInstructions(question: string, closing: string): string {
  return `You are Alexa, a market researcher. If the person said no, declined, or has no time, say exactly: "${closing}" Otherwise say exactly: "${question}" Nothing else.`;
}

/** Did this reply say this line? Compared word by word, ignoring case and punctuation. */
function saidLine(reply: string, line: string): boolean {
  const words = (t: string) => t.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const target = words(line);
  if (target.length === 0) return false;
  const said = new Set(words(reply));
  const hits = target.filter((w) => said.has(w)).length;
  return hits / target.length >= 0.8;
}

/**
 * Save the event log as a JSON file. Audio payloads (input_audio_buffer.append
 * `audio`, response.output_audio.delta `delta`) are replaced by their length,
 * which keeps the file small and readable; everything else is verbatim.
 */
function downloadLog(entries: LogEntry[]): void {
  const slim = entries.map((e) => {
    const raw = e.raw as Record<string, unknown> | null;
    let copy: unknown = raw;
    if (raw && typeof raw === "object") {
      const c: Record<string, unknown> = { ...raw };
      if (e.type === "input_audio_buffer.append" && typeof c.audio === "string") {
        c.audio = `<${c.audio.length} base64 chars>`;
      }
      if (e.type === "response.output_audio.delta" && typeof c.delta === "string") {
        c.delta = `<${c.delta.length} base64 chars>`;
      }
      copy = c;
    }
    return { at: new Date(e.at).toISOString(), dir: e.dir, type: e.type, raw: copy };
  });
  const blob = new Blob([JSON.stringify(slim, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `event-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** The questions box as a list: one per line, blanks dropped. */
function splitQuestions(text: string): string[] {
  return text
    .split("\n")
    .map((q) => q.trim())
    .filter(Boolean);
}

/**
 * Ask Claude Haiku 5.5 (through our server) what to add to and remove from
 * the questions not asked yet.
 */
async function fetchQuestionChanges(payload: {
  context: string;
  audience: "customer" | "expert";
  asked: string[];
  remaining: string[];
  transcript: string;
}): Promise<Omit<LlmCall, "id" | "at">> {
  try {
    const res = await fetch("/api/questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    const prompt = body.prompt ?? {};
    const common = { model: prompt.model, system: prompt.system, user: prompt.user, ms: body.ms };
    if (!res.ok) return { ...common, status: "error", error: body.error ?? `HTTP ${res.status}` };
    return { ...common, status: "ok", raw: body.raw, add: body.add ?? [], remove: body.remove ?? [] };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Ask our own server for a fresh ephemeral key. One per connection. */
async function fetchToken(): Promise<string> {
  const res = await fetch("/api/token");
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.value as string;
}

export default function App() {
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [activity, setActivity] = useState<Activity>("idle");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [closeMessage, setCloseMessage] = useState<string | null>(null);
  const [text, setText] = useState("Hi! Say something short so I can check my speakers.");
  const [transcript, setTranscript] = useState<TranscriptState>(emptyTranscript);
  // The latest transcript, readable from event callbacks without waiting for a render.
  const transcriptRef = useRef<TranscriptState>(emptyTranscript);
  // What Claude did last, shown next to the questions box.
  const [claudeStatus, setClaudeStatus] = useState("not called yet");
  // Every Claude call, newest last, for the panel under the questions box.
  const [llmCalls, setLlmCalls] = useState<LlmCall[]>([]);
  const llmSeq = useRef(0);
  const [micActive, setMicActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [micStartAt, setMicStartAt] = useState<number | null>(null);
  // SYSTEM INSTRUCTIONS: sent in the first session.update on connect, and again
  // whenever "Send session.update" is pressed.
  const [instructions, setInstructions] = useState(DEFAULT_INSTRUCTIONS);
  const instructionsRef = useRef(instructions);
  instructionsRef.current = instructions;
  // QUESTIONS: each time Alexa finishes a reply (response.done), the next one is sent
  // in its own session.update. Progress resets on every Connect.
  const [questions, setQuestions] = useState(DEFAULT_QUESTIONS);
  const questionsRef = useRef(questions);
  questionsRef.current = questions;
  // A question counts as ASKED only once Alexa has actually said it (her
  // transcript matches it), not when it was sent. The next one sent is always
  // the first question she has not said yet.
  const askedRef = useRef<Set<string>>(new Set());
  const [askedCount, setAskedCount] = useState(0);
  const greetingAnsweredRef = useRef(false);
  const closingSentRef = useRef(false);
  // Claude's edits, for the live list: when each question was added, and
  // what was removed.
  const [addedAt, setAddedAt] = useState<Record<string, number>>({});
  const [removedQs, setRemovedQs] = useState<RemovedQuestion[]>([]);
  const [goal, setGoal] = useState(DEFAULT_GOAL);
  // Who Alexa is talking to; Claude writes simpler questions for customers.
  const [audience, setAudience] = useState<"customer" | "expert">("customer");
  const audienceRef = useRef(audience);
  audienceRef.current = audience;
  const goalRef = useRef(goal);
  goalRef.current = goal;
  const [closing, setClosing] = useState(DEFAULT_CLOSING);
  const closingRef = useRef(closing);
  closingRef.current = closing;

  /**
   * Send the transcript and the question list to Claude, then apply its
   * changes to the questions not asked yet. Asked questions stay where they
   * are, so the "next question" index keeps pointing at the right line.
   */
  const isAsked = (q: string) => askedRef.current.has(q.toLowerCase());

  async function refreshQuestions(): Promise<void> {
    const before = splitQuestions(questionsRef.current);
    setClaudeStatus("updating…");
    const id = ++llmSeq.current;
    setLlmCalls((calls) => [...calls, { id, at: Date.now(), status: "pending" }]);
    const result = await fetchQuestionChanges({
      context: goalRef.current,
      audience: audienceRef.current,
      asked: before.filter(isAsked),
      remaining: before.filter((q) => !isAsked(q)),
      transcript: toPlainText(transcriptRef.current),
    });
    setLlmCalls((calls) => calls.map((c) => (c.id === id ? { ...c, ...result } : c)));
    if (result.status === "error") {
      setClaudeStatus(`error: ${result.error}`);
      return;
    }
    const add = result.add ?? [];
    const remove = result.remove ?? [];
    // Re-read the list: you may have edited it, or a question may have been
    // sent, while Claude was thinking.
    const now = splitQuestions(questionsRef.current);
    const drop = new Set(remove.map((q) => q.trim().toLowerCase()));
    const kept = now.filter((q) => isAsked(q) || !drop.has(q.toLowerCase()));
    const gone = now.filter((q) => !kept.includes(q));
    const fresh = add.map((q) => q.trim()).filter((q) => q && !kept.some((k) => k.toLowerCase() === q.toLowerCase()));
    const updated = [...kept, ...fresh].join("\n");
    const stamp = Date.now();
    if (gone.length) setRemovedQs((r) => [...r, ...gone.map((text) => ({ text, at: stamp }))]);
    if (fresh.length)
      setAddedAt((a) => ({ ...a, ...Object.fromEntries(fresh.map((q) => [q.toLowerCase(), stamp])) }));
    questionsRef.current = updated;
    setQuestions(updated);
    setClaudeStatus(`last update ${new Date().toLocaleTimeString(undefined, { hour12: false })}: +${add.length} −${remove.length}`);
  }

  // The client outlives re-renders, so it lives in a ref rather than state.
  const clientRef = useRef<RealtimeClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new RealtimeClient({
      tokenProvider: fetchToken,
      instructionsProvider: () => instructionsRef.current,
      speakFirst: true,
      endsSession: (reply) => saidLine(reply, closingRef.current),
      nextInstructions: () => {
        const pending = splitQuestions(questionsRef.current).filter((q) => !isAsked(q));
        const close = closingRef.current.trim();
        // First turn after the greeting: the model decides yes (ask) or no (closing).
        if (!greetingAnsweredRef.current) {
          greetingAnsweredRef.current = true;
          if (pending.length > 0 && close) return firstQuestionInstructions(pending[0], close);
        }
        if (pending.length > 0) return questionInstructions(pending[0]);
        // Every question has been said: the closing, once.
        if (close && !closingSentRef.current) {
          closingSentRef.current = true;
          return questionInstructions(close);
        }
        return null;
      },
      onConnectionState: setConnection,
      onActivity: setActivity,
      onLog: (entry) => setLog((l) => [...l, entry]),
      onClose: (info) => setCloseMessage(info.message),
      onMicChange: (active) => {
        setMicActive(active);
        // The timeline's zero point: every start of the microphone resets it.
        if (active) setMicStartAt(Date.now());
      },
      onMicLevel: setMicLevel,
      // Every server event goes through the reducer. That is the whole wiring:
      // the client knows nothing about the transcript, and the transcript knows
      // nothing about sockets.
      onServerEvent: (evt) => {
        const next = transcriptReducer(transcriptRef.current, evt, Date.now());
        transcriptRef.current = next;
        setTranscript(next);
        // Alexa finished a reply: mark every question she actually said as asked.
        if (evt.type === SERVER.audioTranscriptDone && typeof evt.transcript === "string") {
          for (const q of splitQuestions(questionsRef.current)) {
            if (saidLine(evt.transcript, q)) askedRef.current.add(q.toLowerCase());
          }
          setAskedCount(askedRef.current.size);
        }
        // Your words just arrived: let Claude revise the questions not yet asked.
        if (evt.type === SERVER.transcriptionCompleted) void refreshQuestions();
      },
    });
  }

  useEffect(() => {
    const client = clientRef.current!;
    return () => void client.close();
  }, []);

  const connect = useCallback(async () => {
    setCloseMessage(null);
    askedRef.current = new Set();
    setAskedCount(0);
    setAddedAt({});
    setRemovedQs([]);
    greetingAnsweredRef.current = false;
    closingSentRef.current = false;
    await clientRef.current!.connect();
  }, []);

  const send = useCallback(() => {
    if (!text.trim()) return;
    clientRef.current!.sendUserText(text);
  }, [text]);

  const toggleMic = useCallback(async () => {
    const client = clientRef.current!;
    setMicError(null);
    try {
      if (client.micActive) await client.stopMic();
      else await client.startMic();
    } catch (e) {
      // Denied permission, no input device, or an insecure origin. All three
      // land here and all three are worth telling the user about explicitly.
      setMicError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const isOpen = connection === "open";

  return (
    <main className="app">
      <h1>Higgs Realtime Tutorial</h1>
      <p className="lede">
        The finished app. Ask about something it could not know — the weekend
        weather in Willow Creek, say — and it will search for it and speak what
        it found.
      </p>

      <div className="layout">
      <div className="layout-left">
      <SessionPanel
        instructions={instructions}
        onChange={setInstructions}
        onSend={() => clientRef.current!.updateInstructions(instructions)}
        canSend={isOpen}
        entries={log}
      />

      <label className="field">
        <span>
          Questions — one per line. Each time Alexa finishes a reply, the first one she has not
          said yet is sent in a new session.update, ready for her next turn (said so far: {askedCount}). Claude Haiku 5.5
          edits the ones not yet said after each of your turns — {claudeStatus}
        </span>
        <textarea value={questions} onChange={(e) => setQuestions(e.target.value)} rows={4} />
      </label>

      <label className="field">
        <span>Interviewee — sent to Claude</span>
        <select value={audience} onChange={(e) => setAudience(e.target.value as "customer" | "expert")}>
          <option value="customer">Customer (e.g. someone who buys Nike)</option>
          <option value="expert">Industry expert</option>
        </select>
      </label>

      <label className="field">
        <span>Interview goal — sent to Claude as context</span>
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} />
      </label>

      <label className="field">
        <span>
          Closing — said after the last answer, or right away if the greeting is declined; the
          session ends once Alexa has said it
        </span>
        <textarea value={closing} onChange={(e) => setClosing(e.target.value)} rows={2} />
      </label>

      <StatusBar connection={connection} activity={activity} closeMessage={closeMessage} />

      <div className="row">
        <button onClick={connect} disabled={connection === "connecting" || isOpen}>
          {connection === "connecting" ? "Connecting…" : "Connect"}
        </button>
        <button onClick={() => clientRef.current!.disconnect()} disabled={!isOpen}>
          Disconnect
        </button>
      </div>

      <MicButton
        active={micActive}
        level={micLevel}
        disabled={!isOpen}
        onToggle={toggleMic}
      />
      {micError && <p className="error">{micError}</p>}

      <details className="typed">
        <summary>…or type instead (Part 1's path, still here)</summary>
        <div className="row">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && isOpen && send()}
            placeholder="Type something for the model to say back…"
            disabled={!isOpen}
          />
          <button onClick={send} disabled={!isOpen}>
            Send
          </button>
        </div>
      </details>

      <SpeechTimeline entries={log} micStartAt={micStartAt} micActive={micActive} />

      <VoiceEventsPanel entries={log} />

      <label className="field">
        <span>Current transcript</span>
        <textarea readOnly value={toPlainText(transcript)} rows={10} />
      </label>

      <div className="row">
        <button onClick={() => downloadLog(log)} disabled={log.length === 0}>
          Download event log (JSON)
        </button>
      </div>

      <DebugDrawer entries={log} />
      </div>

      {/* Right column: what Claude is doing to the questions, live. */}
      <aside className="layout-right">
        <QuestionList
          questions={splitQuestions(questions)}
          isSaid={isAsked}
          addedAt={addedAt}
          removed={removedQs}
          updating={claudeStatus === "updating…"}
        />

        <LlmPanel calls={llmCalls} />
      </aside>
      </div>
    </main>
  );
}
