// The wire protocol: what we send, what the server sends back, and what its
// close codes mean.
//
// Note how loose the two envelope types are. That is deliberate. The server
// emits more event types than any one part of this tutorial handles, and it may
// add more later. Code that throws on an unrecognised `type` would break the
// moment the API grew a feature. Instead we type the envelope, log everything,
// and act only on the events we care about.

/** Anything the server sends. `type` is the discriminator; the rest varies. */
export interface ServerEvent {
  type: string;
  event_id?: string;
  [key: string]: unknown;
}

/** Anything we send. */
export interface ClientEvent {
  type: string;
  [key: string]: unknown;
}

// --- Server event names ------------------------------------------------------
// Verified against the live server-events reference on 2026-08-07. Only the
// events this tutorial acts on are listed; the debug drawer shows the rest.

export const SERVER = {
  /** Acknowledges the first session.update — carries the full resolved session. */
  sessionCreated: "session.created",
  /** Acknowledges every later session.update. */
  sessionUpdated: "session.updated",

  /** The server's VAD heard you start talking. The barge-in trigger. */
  speechStarted: "input_audio_buffer.speech_started",
  /** The server's VAD heard you stop. A turn is about to be created. */
  speechStopped: "input_audio_buffer.speech_stopped",
  /** The text of what you said. Arrives well after the turn itself. */
  transcriptionCompleted: "conversation.item.input_audio_transcription.completed",
  /** Transcription was attempted and failed — show something, not nothing. */
  transcriptionFailed: "conversation.item.input_audio_transcription.failed",

  /** A new assistant turn has begun. */
  responseCreated: "response.created",
  /** An item (assistant message, tool call) was added to the response. */
  outputItemAdded: "response.output_item.added",
  /** The turn is over. */
  responseDone: "response.done",

  /** A chunk of audio bytes, base64 in `delta`. This is the one you play. */
  outputAudioDelta: "response.output_audio.delta",
  outputAudioDone: "response.output_audio.done",

  /** Streaming text of what the model is saying, as it says it. */
  audioTranscriptDelta: "response.output_audio_transcript.delta",
  audioTranscriptDone: "response.output_audio_transcript.done",

  /** The model wants to call a tool; the arguments are complete. */
  functionCallArgsDone: "response.function_call_arguments.done",

  /** Something went wrong. Always read these — they explain rejected config. */
  error: "error",

  /** No user speech for five minutes; the socket closes right after. */
  idleTimeout: "session.idle_timeout",
  /** The session hit the server's wall-clock cap; the socket closes right after. */
  maxDuration: "session.max_duration_reached",
} as const;

// --- Close codes -------------------------------------------------------------
// A WebSocket close carries a numeric code, and the Realtime API uses specific
// ones to tell you *why* you were disconnected. Mapping them to distinct
// messages is the difference between "something went wrong" and "your key
// expired". From the realtime API overview, read 2026-08-07.

export interface CloseInfo {
  code: number;
  reason: string;
  /** A human-legible one-liner suitable for showing a user. */
  message: string;
  /** Whether reconnecting is likely to help. */
  retryable: boolean;
}

export function describeClose(code: number, reason: string): CloseInfo {
  switch (code) {
    case 1000:
      // Normal closure — which includes the session-limit closes (idle timeout,
      // max duration). Those arrive with their reason in the close frame, and
      // are preceded by a session.idle_timeout / session.max_duration_reached
      // event, so you always know which one you got.
      return {
        code,
        reason,
        message: reason ? `Session closed normally: ${reason}` : "Session closed normally.",
        retryable: true,
      };
    case 1013:
      return {
        code,
        reason,
        message: "Server at max concurrency (1013). Try again in a moment.",
        retryable: true,
      };
    case 3000:
      return {
        code,
        reason,
        message: "Authentication failed (3000): the key was invalid or had expired.",
        retryable: false,
      };
    case 4429:
      return {
        code,
        reason,
        message:
          "Billing entitlement refused (4429). Check your balance — an `error` event just before this has the detail.",
        retryable: false,
      };
    default:
      return {
        code,
        reason,
        message: `Socket closed (${code})${reason ? `: ${reason}` : ""}.`,
        // 1006 is "closed abnormally" — no close frame arrived at all, which
        // usually means a network drop rather than a decision by the server.
        retryable: code === 1006,
      };
  }
}

// --- Client event builders ---------------------------------------------------

/**
 * A typed text turn. Two events, always in this order: put the message into the
 * conversation, then ask the model to respond to it.
 */
export function userTextItem(text: string): ClientEvent {
  return {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  };
}

/**
 * Ask the model to produce a turn. Adding an item to the conversation does not
 * start a response — this is what does. (In Part 2, when the server is
 * detecting turns for you, you stop sending this entirely.)
 */
export function responseCreate(): ClientEvent {
  return { type: "response.create" };
}

/**
 * SCRIPT CONTROL — make the model say a given line, as an ordinary turn.
 *
 * The API's ways to influence what the model says, and why this uses the mix
 * it does:
 *
 *  - `session.update` → `instructions`: the system prompt. It applies to every
 *    turn, so the line would leak into the rest of the conversation.
 *  - `conversation.item.create` with an assistant `text` item: writes the line
 *    into history only. Creating an item never produces audio, and a
 *    response.create afterwards makes the model continue *after* it.
 *  - `response.create` → `response.instructions` on its own: verified against
 *    the live API on 2026-10-24, a long paragraph was read back word for word,
 *    but "What's your name?" came out as "Hello! How can I assist you today?",
 *    with two different wordings of the instruction.
 *
 * So the client sends three things:
 *
 *  1. `conversation.item.create` — a user request carrying the line, with an
 *     id we choose (scriptRequestItem). The model follows a user request to
 *     say something far more reliably than an instruction on an empty
 *     conversation.
 *  2. `response.create` with per-response `instructions` saying the same
 *     thing (scriptResponse), tagged with `metadata` so the reply can be
 *     recognised when `response.created` echoes it back.
 *  3. `conversation.item.delete` of that request once the reply has ended —
 *     completed or cut off — so the history holds only what Higgs said, not
 *     the stage direction that produced it.
 *
 * The reply itself is a normal response: same output_item.added, audio
 * deltas and transcript events, so playback, the transcript, and barge-in
 * (flush + conversation.item.truncate) apply to it unchanged.
 */
export const SCRIPT_METADATA = { source: "script" } as const;

export function newScriptItemId(): string {
  return `script_${Math.random().toString(36).slice(2, 12)}`;
}

export function scriptRequestItem(script: string, itemId: string): ClientEvent {
  return {
    type: "conversation.item.create",
    item: {
      id: itemId,
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: `Say exactly this, word for word, and nothing else: "${script}"` },
      ],
    },
  };
}

export function deleteItem(itemId: string): ClientEvent {
  return { type: "conversation.item.delete", item_id: itemId };
}

export function scriptInstructions(script: string): string {
  return [
    "Your reply is fixed: say exactly the text inside the quotation marks below, word for",
    "word, as your own words, and nothing else. Do not answer it, greet, or add anything",
    "before or after it, and do not use tools.",
    "",
    `"${script}"`,
  ].join("\n");
}

export function scriptResponse(script: string): ClientEvent {
  return {
    type: "response.create",
    response: {
      instructions: scriptInstructions(script),
      metadata: { ...SCRIPT_METADATA },
    },
  };
}

/**
 * Stream one chunk of microphone audio: base64-encoded PCM16 at the session's
 * input rate. We send roughly one of these every 100 ms.
 *
 * There is no "commit" to send afterwards — with turn detection enabled the
 * server decides where your turn ends. (Set `turn_detection: null` and you take
 * that job back, using `input_audio_buffer.commit` to mark the end yourself.)
 */
export function inputAudioAppend(base64: string): ClientEvent {
  return { type: "input_audio_buffer.append", audio: base64 };
}

/**
 * Hand a tool's result back to the model.
 *
 * `output` is a STRING, even though what you are returning is structured — so
 * it needs JSON.stringify, and a plain object here silently produces
 * "[object Object]".
 */
export function functionCallOutput(callId: string, output: string): ClientEvent {
  return {
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output },
  };
}

/**
 * Tell the server that only the first `audioEndMs` of an assistant item was
 * actually heard, and to forget the rest.
 *
 * `content_index` identifies which content part of the item to cut; an audio
 * reply has one, at index 0.
 */
export function truncateItem(itemId: string, audioEndMs: number): ClientEvent {
  return {
    type: "conversation.item.truncate",
    item_id: itemId,
    content_index: 0,
    audio_end_ms: Math.round(audioEndMs),
  };
}
