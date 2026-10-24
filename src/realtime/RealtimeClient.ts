import {
  SERVER,
  describeClose,
  functionCallOutput,
  inputAudioAppend,
  responseCreate,
  truncateItem,
  userTextItem,
  type ClientEvent,
  type CloseInfo,
  type ServerEvent,
} from "./events";
import { buildSessionConfig } from "./sessionConfig";
import { RingPlayer } from "../audio/playback";
import { MicCapture } from "../audio/capture";
import { dispatch as dispatchTool } from "../tools/registry";
import { CLIENT_TOOL_RESULT } from "../state/transcriptStore";

// The model can also be set in session.update; passing it in the URL means the
// server knows which model you want before the first byte of config arrives.
const WS_URL = "wss://api.boson.ai/v1/realtime?model=higgs-realtime";

export type ConnectionState = "idle" | "connecting" | "open" | "closing" | "closed";

/** Coarse state for the status bar. */
export type Activity = "idle" | "listening" | "thinking" | "speaking";

export interface LogEntry {
  id: number;
  dir: "recv" | "send" | "info";
  type: string;
  at: number;
  raw: unknown;
}

export interface RealtimeCallbacks {
  onConnectionState?: (s: ConnectionState) => void;
  onActivity?: (a: Activity) => void;
  onLog?: (entry: LogEntry) => void;
  onServerEvent?: (evt: ServerEvent) => void;
  onClose?: (info: CloseInfo) => void;
  /** Fired when the microphone starts or stops. */
  onMicChange?: (active: boolean) => void;
  /** Live microphone level (RMS, ~10 per second) for the meter. */
  onMicLevel?: (rms: number) => void;
  /** Mints a fresh ephemeral key for each connection. Required. */
  tokenProvider: () => Promise<string>;
  /**
   * The system instructions for the first session.update on each connection.
   * Empty or absent means the tutorial's SYSTEM_PROMPT.
   */
  instructionsProvider?: () => string;
  /**
   * When true, Higgs speaks first: once per connection, as soon as the session
   * is acknowledged (session.created) and the microphone is on, the client
   * sends a bare response.create — no user turn needed.
   */
  speakFirst?: boolean;
  /**
   * Called each time an assistant reply ends (response.done, unless a tool
   * call means another reply is coming). Return the instructions for the NEXT
   * reply to send them in a session.update right away, or null to send nothing.
   */
  nextInstructions?: () => string | null;
  /**
   * Called with the full text of each assistant reply
   * (response.output_audio_transcript.done). Return true to end the session
   * once that reply has finished playing.
   */
  endsSession?: (assistantText: string) => boolean;
}

/**
 * Where Higgs's audio goes when an avatar is attached (src/avatar/AvatarLink.ts)
 * instead of the local speaker.
 */
export interface AvatarSink {
  pushAudio(b64: string): void;
  endSegment(): void;
  /** Stop and drop queued audio; resolves with the ms actually played, if known. */
  clear(): Promise<number | null>;
}

let logSeq = 0;

/**
 * Everything to do with the WebSocket lives here, behind a callback interface.
 * React components never touch the socket — they render what this reports.
 */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private state: ConnectionState = "idle";
  private player: RingPlayer;
  private capture: MicCapture;
  private cb: RealtimeCallbacks;

  /**
   * The assistant item currently producing audio. This is what we truncate on
   * barge-in, so we track it from whichever event mentions it first.
   */
  private currentAssistantItemId: string | null = null;

  /**
   * Every call_id we have already started running.
   *
   * Tool calls can be announced twice — once by
   * response.function_call_arguments.done and again in response.done's output
   * list. Without this Set you execute each one twice, which for a search is
   * merely wasteful and for anything that writes is a real bug.
   */
  private handledCallIds = new Set<string>();

  /**
   * Tool calls belonging to the response currently being generated.
   *
   * The model can request several at once. Each result must come back as its
   * own function_call_output, but there must be exactly ONE response.create
   * afterwards — so the batch is collected here and flushed together.
   */
  private toolBatch: { promises: Promise<void>[]; outputs: ClientEvent[] } | null = null;

  /**
   * ⚠ The single most important line in this file.
   *
   * React StrictMode mounts every component twice in development, so an effect
   * that calls connect() opens two sockets.
   *
   * The API does not stop you: verified 2026-08-07, two sockets sharing one
   * ephemeral key both get their own session.created with different session
   * ids, and both keep working. So there is no error to notice — just two live
   * conversations, two audio streams playing over each other, and two sessions
   * on the bill. It sounds like the model is echoing itself.
   *
   * Guarding here rather than in the component means it holds for every caller,
   * including a user double-clicking the button.
   */
  private connecting = false;

  /** session.created has arrived on this connection. */
  private sessionReady = false;
  /** The speak-first response.create has been sent on this connection. */
  private spokeFirst = false;
  /** When set, Higgs's audio goes to the avatar and the local player stays silent. */
  private avatar: AvatarSink | null = null;
  /** Disconnect as soon as playback finishes (the closing line was said). */
  private endAfterPlayback = false;
  private endFallback: ReturnType<typeof setTimeout> | null = null;

  constructor(callbacks: RealtimeCallbacks) {
    this.cb = callbacks;
    this.player = new RingPlayer((speaking) => {
      if (!speaking) this.onPlaybackIdle();
    });
    this.capture = new MicCapture(
      (base64) => this.send(inputAudioAppend(base64)),
      (rms) => this.cb.onMicLevel?.(rms),
    );
  }

  /**
   * Route Higgs's audio to an avatar (or back to the local player with null).
   * Only one of the two ever plays it, so there is no duplicate audio.
   */
  setAvatar(sink: AvatarSink | null): void {
    this.avatar = sink;
  }

  /** The avatar finished speaking an utterance (its lk.playback_finished). */
  notifyAvatarPlaybackFinished(): void {
    this.onPlaybackIdle();
  }

  /** Resume the local AudioContext; call inside the click that starts things. */
  resumeAudio(): Promise<void> {
    return this.player.resume();
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get micActive(): boolean {
    return this.capture.active;
  }

  /** Start streaming microphone audio. Throws if permission is denied. */
  async startMic(): Promise<void> {
    await this.capture.start();
    this.cb.onMicChange?.(true);
    this.setActivity("listening");
    this.info("Microphone started.");
    this.maybeSpeakFirst();
  }

  async stopMic(): Promise<void> {
    await this.capture.stop();
    this.cb.onMicChange?.(false);
    this.cb.onMicLevel?.(0);
    this.setActivity("idle");
    this.info("Microphone stopped.");
  }

  /** Mint a key and open the socket. Safe to call twice; the second is ignored. */
  async connect(): Promise<void> {
    if (this.connecting || this.state === "open" || this.state === "connecting") {
      this.info("connect() ignored — a connection is already active.");
      return;
    }
    this.connecting = true;
    this.sessionReady = false;
    this.spokeFirst = false;
    this.endAfterPlayback = false;
    this.setState("connecting");

    // Must happen inside the user gesture that triggered this call, or the
    // browser leaves the AudioContext suspended and playback is silent.
    await this.player.resume();

    let key: string;
    try {
      key = await this.cb.tokenProvider();
    } catch (e) {
      this.connecting = false;
      this.setState("closed");
      const message = e instanceof Error ? e.message : String(e);
      this.cb.onClose?.({ code: 0, reason: "", message: `Token error: ${message}`, retryable: false });
      return;
    }

    // A browser cannot set headers on a WebSocket handshake, so there is no
    // `Authorization` header to use. The API takes the credential as a
    // subprotocol instead: "realtime" names the protocol, and the second entry
    // carries the ephemeral key.
    const ws = new WebSocket(WS_URL, ["realtime", `bai-client-secret.${key}`]);
    this.ws = ws;

    ws.onopen = () => {
      this.connecting = false;
      this.setState("open");
      this.info("Socket open — sending session.update.");
      const instructions = this.cb.instructionsProvider?.().trim();
      this.send(instructions ? buildSessionConfig(instructions) : buildSessionConfig());
    };
    ws.onmessage = (ev) => this.onMessage(ev);
    ws.onerror = () => this.info("WebSocket error — the close code below has the detail.");
    ws.onclose = (ev) => {
      this.connecting = false;
      this.ws = null;
      this.sessionReady = false;
      const info = describeClose(ev.code, ev.reason);
      this.log("info", `close:${ev.code}`, info);
      this.setState("closed");
      this.setActivity("idle");
      this.cb.onClose?.(info);
    };
  }

  disconnect(): void {
    if (this.ws && (this.state === "open" || this.state === "connecting")) {
      this.setState("closing");
      this.ws.close(1000, "client disconnect");
    } else {
      this.setState("closed");
    }
    void this.capture.stop().then(() => this.cb.onMicChange?.(false));
  }

  /** Send a typed message and ask for a reply. */
  sendUserText(text: string): void {
    if (this.state !== "open") {
      this.info("sendUserText ignored — the socket is not open.");
      return;
    }
    this.send(userTextItem(text));
    // Adding the message does not start a turn. This does.
    this.send(responseCreate());
    this.setActivity("thinking");
  }

  /**
   * Change the system instructions mid-session. Sends the full session config
   * again with the new instructions; the server answers with session.updated.
   */
  updateInstructions(instructions: string): void {
    if (this.state !== "open") {
      this.info("updateInstructions ignored — the socket is not open.");
      return;
    }
    const text = instructions.trim();
    this.send(text ? buildSessionConfig(text) : buildSessionConfig());
  }

  send(evt: ClientEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(evt));
    this.log("send", evt.type, evt);
  }

  async close(): Promise<void> {
    this.disconnect();
    await this.capture.stop();
    await this.player.close();
  }

  // --- internals -------------------------------------------------------------

  private onMessage(ev: MessageEvent): void {
    let evt: ServerEvent;
    try {
      evt = JSON.parse(ev.data as string);
    } catch {
      this.info(`Ignoring non-JSON message: ${String(ev.data).slice(0, 80)}`);
      return;
    }

    // Log first, act second. Everything the server says shows up in the drawer,
    // including the events no branch below handles.
    this.log("recv", evt.type, evt);
    this.cb.onServerEvent?.(evt);

    switch (evt.type) {
      case SERVER.responseCreated:
        // A new assistant turn. Zero the played-sample counter so the truncate
        // maths below measures into *this* reply, not the whole session.
        this.player.reset();
        this.toolBatch = null;
        this.setActivity("thinking");
        break;

      case SERVER.functionCallArgsDone:
        this.onFunctionCallArgsDone(evt);
        break;

      case SERVER.responseDone:
        this.onResponseDone(evt);
        break;

      case SERVER.speechStarted:
        // The user started talking over the model. This is the barge-in path.
        void this.handleBargeIn();
        break;

      case SERVER.audioTranscriptDone: {
        const text = typeof evt.transcript === "string" ? evt.transcript : "";
        if (text && this.cb.endsSession?.(text)) {
          this.info("Closing line said — ending the session after playback.");
          this.endAfterPlayback = true;
          // Fallback in case playback already drained before this event.
          this.endFallback = setTimeout(() => this.endNow("fallback timer"), 15_000);
        }
        break;
      }

      case SERVER.speechStopped:
        this.setActivity("thinking");
        break;

      case SERVER.sessionCreated:
        this.sessionReady = true;
        this.maybeSpeakFirst();
        break;

      case SERVER.outputItemAdded: {
        const item = evt.item as { id?: string; type?: string } | undefined;
        if (item?.type === "message" && typeof item.id === "string") {
          this.currentAssistantItemId = item.id;
        }
        break;
      }

      case SERVER.outputAudioDelta: {
        // The audio itself: base64 PCM16 in `delta`.
        const b64 = evt.delta;
        if (typeof b64 === "string" && b64.length > 0) {
          if (typeof evt.item_id === "string") this.currentAssistantItemId = evt.item_id;
          if (this.avatar) this.avatar.pushAudio(b64);
          else this.player.enqueueBase64(b64);
          this.setActivity("speaking");
        }
        break;
      }

      case SERVER.outputAudioDone:
        // End of this reply's audio: the avatar's segment ends here.
        this.avatar?.endSegment();
        break;

      case SERVER.error:
        // Never let these pass silently. A session field the server rejected is
        // reported here and nowhere else — if you are not watching, your config
        // is quietly not doing what you think it is.
        this.info(`server error: ${JSON.stringify(evt.error ?? evt)}`);
        break;

      default:
        // Unrecognised event types are normal — the server sends more than we
        // handle. They are already logged. Never throw here.
        break;
    }
  }

  /** Nothing is playing any more (local player drained, or the avatar finished). */
  private onPlaybackIdle(): void {
    this.setActivity(this.capture?.active ? "listening" : "idle");
    if (this.endAfterPlayback) this.endNow("closing line finished playing");
  }

  private endNow(why: string): void {
    this.endAfterPlayback = false;
    if (this.endFallback) clearTimeout(this.endFallback);
    this.endFallback = null;
    if (this.state !== "open") return;
    this.info(`Ending the session (${why}).`);
    this.disconnect();
  }

  /** Higgs speaks first: one bare response.create per connection. */
  private maybeSpeakFirst(): void {
    if (!this.cb.speakFirst || this.spokeFirst || !this.sessionReady || !this.capture.active) return;
    this.spokeFirst = true;
    this.info("Speaking first: response.create with no user turn.");
    this.send(responseCreate());
    this.setActivity("thinking");
  }

  // --- the tool loop ---------------------------------------------------------

  /**
   * The model has finished dictating a tool call's arguments. Start running it
   * immediately rather than waiting for response.done — the sooner it starts,
   * the sooner the model can speak the answer.
   */
  private onFunctionCallArgsDone(evt: ServerEvent): void {
    const callId = typeof evt.call_id === "string" ? evt.call_id : undefined;
    const name = typeof evt.name === "string" ? evt.name : undefined;
    if (!callId || !name) return;

    let args: Record<string, unknown> = {};
    const raw = typeof evt.arguments === "string" ? evt.arguments : undefined;
    try {
      if (raw) args = JSON.parse(raw);
    } catch {
      // Malformed arguments are the model's mistake, not a reason to crash.
      // Run the tool with nothing and let it return its own complaint.
      this.info(`could not parse arguments for ${name}: ${raw}`);
    }
    this.startToolCall(callId, name, args);
  }

  private startToolCall(callId: string, name: string, args: Record<string, unknown>): void {
    // ⚠ The guard that stops the double-fire. See onResponseDone.
    if (this.handledCallIds.has(callId)) return;
    this.handledCallIds.add(callId);

    if (!this.toolBatch) this.toolBatch = { promises: [], outputs: [] };
    const batch = this.toolBatch;
    const startedAt = Date.now();

    const p = (async () => {
      let result: unknown;
      try {
        result = await dispatchTool(name, args);
      } catch (e) {
        // A thrown handler must still produce an output, or the model waits
        // forever for a call_id that never comes back.
        this.info(`tool ${name} threw: ${e instanceof Error ? e.message : String(e)}`);
        result = { summary: "That lookup failed.", error: "tool_failed" };
      }
      // Feed the result into the transcript through the same reducer path as
      // everything else, using a synthetic event type of our own.
      this.cb.onServerEvent?.({
        type: CLIENT_TOOL_RESULT,
        call_id: callId,
        result,
        ms: Date.now() - startedAt,
      });
      batch.outputs.push(functionCallOutput(callId, JSON.stringify(result)));
    })();

    batch.promises.push(p);
  }

  /**
   * The turn is over. If it contained tool calls, this is where we answer them.
   */
  private onResponseDone(evt: ServerEvent): void {
    // Close the avatar's segment even if output_audio.done never came.
    this.avatar?.endSegment();
    // ⚠ The double-fire. Tool calls that already arrived via
    // function_call_arguments.done can appear AGAIN in response.done's output
    // list. We still walk it — occasionally a call shows up only here — but
    // handledCallIds means nothing runs twice.
    const output = (evt.response as { output?: unknown[] } | undefined)?.output ?? [];
    for (const raw of output) {
      const item = raw as { type?: string; name?: string; call_id?: string; arguments?: string };
      if (item?.type === "function_call" && item.call_id && item.name) {
        let args: Record<string, unknown> = {};
        try {
          if (item.arguments) args = JSON.parse(item.arguments);
        } catch {
          /* handled above */
        }
        this.startToolCall(item.call_id, item.name, args);
      }
    }

    if (this.toolBatch && this.toolBatch.promises.length > 0) {
      void this.flushToolBatch();
    } else {
      this.setActivity(this.capture.active ? "listening" : "idle");
      // Alexa's turn is over: load the instructions for her NEXT reply now,
      // before you answer. The server starts that reply by itself the moment
      // its VAD hears you stop, so instructions sent at speech_stopped arrive
      // too late for it.
      const next = this.cb.nextInstructions?.();
      if (next) this.send(buildSessionConfig(next));
    }
  }

  /**
   * Wait for every tool in this turn, send one output per call_id, then exactly
   * one response.create.
   *
   * Both halves of that matter. Miss an output and the model hangs waiting for
   * a call_id it never hears back about. Send response.create per tool instead
   * of once, and you get two replies talking over each other.
   */
  private async flushToolBatch(): Promise<void> {
    const batch = this.toolBatch;
    this.toolBatch = null;
    if (!batch || batch.promises.length === 0) return;

    if (batch.promises.length > 1) {
      this.info(`${batch.promises.length} tool calls in one turn — running them in parallel`);
    }
    this.setActivity("thinking");

    // Promise.all, not a loop with await: two independent lookups should take
    // as long as the slower one, not as long as both.
    await Promise.all(batch.promises);

    for (const out of batch.outputs) this.send(out);

    // Mandatory. Without it the model has every result and says nothing.
    this.send(responseCreate());
  }

  /**
   * Barge-in. Two things have to happen, and the second is the one everybody
   * forgets.
   *
   * 1. Stop playing at once. We may be holding several seconds of audio the
   *    user has not heard yet; without this, the model keeps talking over them.
   *
   * 2. Tell the server how much was actually heard. The server has already
   *    stored the whole reply as a conversation item, so its memory now
   *    contains words that never reached anyone's ears. Left alone, the model
   *    will refer back to things it "said" that the user never heard — and
   *    "sorry, what was that last bit?" gets answered from the wrong text.
   *
   * `flush()` resolves with the played-sample count converted to milliseconds,
   * which is exactly `audio_end_ms`. Note we do NOT send response.create here:
   * the server's own VAD starts the new user turn.
   */
  private async handleBargeIn(): Promise<void> {
    this.setActivity("listening");
    // With an avatar, it is the avatar's queue that has to be cleared, and its
    // playback_finished says how far it got.
    const playedMs = this.avatar ? ((await this.avatar.clear()) ?? 0) : await this.player.flush();
    if (this.currentAssistantItemId && playedMs > 0) {
      this.send(truncateItem(this.currentAssistantItemId, playedMs));
    }
    this.currentAssistantItemId = null;
  }

  private setState(s: ConnectionState): void {
    this.state = s;
    this.cb.onConnectionState?.(s);
  }

  private setActivity(a: Activity): void {
    this.cb.onActivity?.(a);
  }

  private info(message: string): void {
    this.log("info", "info", message);
  }

  private log(dir: LogEntry["dir"], type: string, raw: unknown): void {
    this.cb.onLog?.({ id: ++logSeq, dir, type, at: Date.now(), raw });
  }
}
