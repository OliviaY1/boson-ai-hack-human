import { RealtimeClient, type Activity, type ConnectionState } from "../realtime/RealtimeClient";
import { SERVER, type ServerEvent } from "../realtime/events";
import {
  emptyTranscript,
  toList,
  toPlainText,
  transcriptReducer,
  type TranscriptState,
} from "../state/transcriptStore";
import { AvatarLink } from "../avatar/AvatarLink";
import {
  fetchQuestionChanges,
  firstQuestionInstructions,
  questionInstructions,
  saidLine,
  type Audience,
} from "./script";

/**
 * One live interview call, with no UI: Higgs Realtime (voice), the optional
 * Higgs Avatar, and Claude keeping the question list up to date.
 *
 * It runs the same flow as the debug page (src/App.tsx):
 *   - the interviewer (`name`) speaks first (the greeting instructions in `instructions`)
 *   - each time she finishes a reply, the first question she has not said yet
 *     goes out in a session.update, ready for her next turn
 *   - a question counts as said once her transcript matches it
 *   - after each transcription of the interviewee, Claude adds/removes questions
 *   - after the last question, the closing; once she has said it, the call ends
 *
 * The dashboard (frontend/) subscribes with `onChange` and renders `CallState`.
 */

export interface CallConfig {
  /** The interviewer's name, used in every per-step instruction. */
  name: string;
  /** Greeting / system instructions for the first session.update. */
  instructions: string;
  closing: string;
  /** Interview goal, sent to Claude as context. */
  goal: string;
  audience: Audience;
  questions: string[];
  /** e.g. "builtin_claire_v1"; null for voice only. */
  avatarId: string | null;
  /** Where the avatar's video element goes. */
  mediaContainer: HTMLElement | null;
}

export type CallQuestionStatus = "said" | "next" | "pending" | "removed";

export interface CallQuestion {
  id: string;
  text: string;
  status: CallQuestionStatus;
  /** Added by Claude during the call. */
  added: boolean;
  /** When Claude added or removed it. */
  changedAt: number | null;
}

export interface CallTurn {
  id: string;
  speaker: "alexa" | "interviewee";
  text: string;
  at: number;
  interrupted: boolean;
}

export interface CallState {
  phase: "idle" | "starting" | "live" | "ended";
  connection: ConnectionState;
  activity: Activity;
  micActive: boolean;
  /** `room` is the avatar's LiveKit room ("" if none), for watch-only viewers. */
  avatar: { status: "off" | "starting" | "live" | "error" | "ended"; detail: string; room: string };
  /** When the conversation started (mic on, call live) and ended; null until then. */
  startedAt: number | null;
  endedAt: number | null;
  questions: CallQuestion[];
  transcript: CallTurn[];
  claude: { status: "idle" | "updating" | "error"; detail: string };
  /** The last error worth showing, or "". */
  error: string;
}

async function fetchToken(): Promise<string> {
  const res = await fetch("/api/token");
  const body = (await res.json()) as { value?: string; error?: string };
  if (!res.ok || !body.value) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.value;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface QuestionRow {
  id: string;
  text: string;
  status: "said" | "pending" | "removed";
  added: boolean;
  changedAt: number | null;
}

export class CallController {
  private readonly client: RealtimeClient;
  private readonly onChange: (state: CallState) => void;
  private config: CallConfig;

  private phase: CallState["phase"] = "idle";
  private connection: ConnectionState = "idle";
  private activity: Activity = "idle";
  private micActive = false;
  private avatarState: CallState["avatar"] = { status: "off", detail: "", room: "" };
  private startedAt: number | null = null;
  private endedAt: number | null = null;
  private claudeState: CallState["claude"] = { status: "idle", detail: "" };
  private error = "";

  private rows: QuestionRow[] = [];
  private transcript: TranscriptState = emptyTranscript;
  private greetingAnswered = false;
  private closingSent = false;
  private avatar: AvatarLink | null = null;
  private seq = 0;
  private openWaiters: Array<(ok: boolean) => void> = [];

  constructor(config: CallConfig, onChange: (state: CallState) => void) {
    this.config = config;
    this.onChange = onChange;
    this.rows = config.questions.map((text) => this.row(text, false));
    this.client = new RealtimeClient({
      tokenProvider: fetchToken,
      instructionsProvider: () => this.config.instructions,
      speakFirst: true,
      endsSession: (reply) => saidLine(reply, this.config.closing),
      nextInstructions: () => this.nextInstructions(),
      onConnectionState: (s) => this.onConnection(s),
      onActivity: (a) => {
        this.activity = a;
        this.emit();
      },
      onMicChange: (on) => {
        this.micActive = on;
        this.emit();
      },
      onServerEvent: (evt) => this.onServerEvent(evt),
      onClose: (info) => {
        // Say why the call ended unless it was a normal hang-up.
        if (info.code !== 1000 || (info.reason && info.reason !== "client disconnect")) {
          this.error = info.message;
        }
      },
    });
  }

  /** Change the config of a call that has not started (or the question list of a live one). */
  update(partial: Partial<CallConfig>): void {
    this.config = { ...this.config, ...partial };
    if (partial.questions && this.phase === "idle") {
      this.rows = partial.questions.map((text) => this.row(text, false));
      this.emit();
    }
  }

  get state(): CallState {
    const firstPending = this.rows.find((r) => r.status === "pending");
    return {
      phase: this.phase,
      connection: this.connection,
      activity: this.activity,
      micActive: this.micActive,
      avatar: this.avatarState,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      claude: this.claudeState,
      error: this.error,
      questions: this.rows.map((r) => ({
        id: r.id,
        text: r.text,
        status: r === firstPending && this.phase === "live" ? "next" : r.status,
        added: r.added,
        changedAt: r.changedAt,
      })),
      transcript: toList(this.transcript).flatMap((it): CallTurn[] => {
        if (it.kind === "user") {
          return [
            { id: it.itemId, speaker: "interviewee", text: it.text ?? "…", at: it.at, interrupted: false },
          ];
        }
        if (it.kind === "assistant") {
          return [
            {
              id: it.itemId,
              speaker: "alexa",
              text: it.text,
              at: it.at,
              interrupted: it.status === "interrupted",
            },
          ];
        }
        return [];
      }),
    };
  }

  /** Start the call: avatar (if any), Higgs Realtime, then the microphone. Call from a click. */
  async start(): Promise<void> {
    if (this.phase === "starting" || this.phase === "live") return;
    this.phase = "starting";
    this.error = "";
    this.greetingAnswered = false;
    this.closingSent = false;
    this.transcript = emptyTranscript;
    this.startedAt = null;
    this.endedAt = null;
    this.emit();

    // Inside the click: unlock local audio before anything is awaited.
    void this.client.resumeAudio();

    const { avatarId, mediaContainer } = this.config;
    if (avatarId && mediaContainer) await this.startAvatar(avatarId, mediaContainer);

    const opened = new Promise<boolean>((resolve) => {
      this.openWaiters.push(resolve);
      setTimeout(() => resolve(false), 15_000);
    });
    await this.client.connect();
    if (!(await opened)) {
      this.error ||= "Could not open the Higgs Realtime session.";
      await this.stop();
      return;
    }
    try {
      await this.client.startMic();
    } catch (e) {
      this.error = `Microphone: ${errText(e)}`;
      await this.stop();
      return;
    }
    this.phase = "live";
    this.startedAt = Date.now();
    this.emit();
  }

  /** End the call: Higgs, microphone and avatar. Safe to call more than once. */
  async stop(): Promise<void> {
    this.client.disconnect();
    await this.closeAvatar("ended");
    this.markEnded();
    this.emit();
  }

  /** Release everything (component unmount). */
  async dispose(): Promise<void> {
    await this.closeAvatar("ended");
    await this.client.close();
  }

  // --- internals -------------------------------------------------------------

  private markEnded(): void {
    if (this.phase !== "ended") this.endedAt = this.startedAt !== null ? Date.now() : null;
    this.phase = "ended";
  }

  private row(text: string, added: boolean): QuestionRow {
    return { id: `q${++this.seq}`, text, status: "pending", added, changedAt: added ? Date.now() : null };
  }

  private emit(): void {
    this.onChange(this.state);
  }

  private onConnection(s: ConnectionState): void {
    this.connection = s;
    if (s === "open") for (const w of this.openWaiters.splice(0)) w(true);
    if (s === "closed") {
      for (const w of this.openWaiters.splice(0)) w(false);
      // Disconnect, the closing line, or an error: the call is over.
      if (this.phase === "live" || this.phase === "starting") {
        this.markEnded();
        void this.closeAvatar("ended");
      }
    }
    this.emit();
  }

  private nextInstructions(): string | null {
    const pending = this.rows.filter((r) => r.status === "pending");
    const close = this.config.closing.trim();
    const first = pending[0];
    if (!this.greetingAnswered) {
      this.greetingAnswered = true;
      if (first && close) return firstQuestionInstructions(first.text, close, this.config.name);
    }
    if (first) return questionInstructions(first.text, this.config.name);
    if (close && !this.closingSent) {
      this.closingSent = true;
      return questionInstructions(close, this.config.name);
    }
    return null;
  }

  private onServerEvent(evt: ServerEvent): void {
    this.transcript = transcriptReducer(this.transcript, evt, Date.now());

    // Errors from Higgs Realtime are shown, not swallowed.
    if (evt.type === SERVER.error) {
      const e = evt["error"] as { message?: string; type?: string; code?: string } | undefined;
      this.error = `Higgs Realtime error: ${e?.message ?? e?.code ?? e?.type ?? JSON.stringify(evt)}`;
    }

    // The interviewer finished a reply: every question actually said is now "said".
    const said = evt["transcript"];
    if (evt.type === SERVER.audioTranscriptDone && typeof said === "string") {
      for (const r of this.rows) {
        if (r.status === "pending" && saidLine(said, r.text)) r.status = "said";
      }
    }
    // The interviewee's words arrived: let Claude revise the questions not said yet.
    if (evt.type === SERVER.transcriptionCompleted) void this.refreshQuestions();
    this.emit();
  }

  private async refreshQuestions(): Promise<void> {
    this.claudeState = { status: "updating", detail: "" };
    this.emit();
    const result = await fetchQuestionChanges({
      context: this.config.goal,
      audience: this.config.audience,
      asked: this.rows.filter((r) => r.status === "said").map((r) => r.text),
      remaining: this.rows.filter((r) => r.status === "pending").map((r) => r.text),
      transcript: toPlainText(this.transcript),
    });
    if (result.status === "error") {
      this.claudeState = { status: "error", detail: result.error ?? "error" };
      this.emit();
      return;
    }
    const now = Date.now();
    const drop = new Set((result.remove ?? []).map((q) => q.trim().toLowerCase()));
    for (const r of this.rows) {
      if (r.status === "pending" && drop.has(r.text.toLowerCase())) {
        r.status = "removed";
        r.changedAt = now;
      }
    }
    const live = new Set(this.rows.filter((r) => r.status !== "removed").map((r) => r.text.toLowerCase()));
    const adds = (result.add ?? []).map((q) => q.trim()).filter((q) => q && !live.has(q.toLowerCase()));
    for (const text of adds) this.rows.push(this.row(text, true));
    this.claudeState = { status: "idle", detail: `+${adds.length} −${drop.size}` };
    this.emit();
  }

  private async startAvatar(avatarId: string, container: HTMLElement): Promise<void> {
    this.avatarState = { status: "starting", detail: "", room: "" };
    this.emit();
    try {
      const link = await AvatarLink.start(avatarId, {
        mediaContainer: container,
        onPlaybackFinished: () => this.client.notifyAvatarPlaybackFinished(),
        onEnded: (reason) => void this.closeAvatar("error", `${reason} — audio continues locally`),
      });
      this.avatar = link;
      this.client.setAvatar(link);
      this.avatarState = { status: "live", detail: link.sessionId, room: link.roomName };
    } catch (e) {
      this.client.setAvatar(null);
      this.avatarState = { status: "error", detail: `${errText(e)} — continuing with voice only`, room: "" };
    }
    this.emit();
  }

  private async closeAvatar(status: "ended" | "error", detail = ""): Promise<void> {
    const link = this.avatar;
    this.avatar = null;
    this.client.setAvatar(null);
    if (!link) return;
    this.avatarState = { status, detail, room: "" };
    this.emit();
    await link.close();
  }
}
