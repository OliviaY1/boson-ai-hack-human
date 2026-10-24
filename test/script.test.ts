import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeClient } from "../src/realtime/RealtimeClient";
import {
  SCRIPT_METADATA,
  scriptResponse,
  type ClientEvent,
  type ServerEvent,
} from "../src/realtime/events";
import { SYSTEM_PROMPT } from "../src/realtime/sessionConfig";
import { emptyTranscript, toList, transcriptReducer } from "../src/state/transcriptStore";

// SCRIPT CONTROL — the client side of it, with no network and no audio.
//
// The socket is a fake that records what the client sends and lets the test
// play the server. Playback and capture are swapped for stubs, because what is
// under test is the protocol: when the script goes out, what it looks like, and
// that a scripted turn is interrupted exactly like any other.

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | null = null;

  readyState = 0;
  sent: ClientEvent[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.last = this;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  // --- test helpers: play the server ---
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(evt: ServerEvent): void {
    this.onmessage?.({ data: JSON.stringify(evt) });
  }

  sentOfType(type: string): ClientEvent[] {
    return this.sent.filter((e) => e.type === type);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeClient(getScript: () => string) {
  const serverEvents: ServerEvent[] = [];
  const client = new RealtimeClient({
    tokenProvider: async () => "bai-eph-test",
    scriptProvider: getScript,
    onServerEvent: (evt) => serverEvents.push(evt),
  });

  // Stand-ins for the AudioWorklet classes. flush() reports 1.234 s heard.
  const player = {
    resume: vi.fn(async () => {}),
    reset: vi.fn(),
    enqueueBase64: vi.fn(),
    flush: vi.fn(async () => 1234),
    close: vi.fn(async () => {}),
  };
  let micOn = false;
  const capture = {
    get active() {
      return micOn;
    },
    start: vi.fn(async () => {
      micOn = true;
    }),
    stop: vi.fn(async () => {
      micOn = false;
    }),
  };
  const internals = client as unknown as { player: unknown; capture: unknown };
  internals.player = player;
  internals.capture = capture;

  return { client, player, serverEvents };
}

async function connectAndOpen(client: RealtimeClient): Promise<FakeSocket> {
  await client.connect();
  const ws = FakeSocket.last!;
  ws.open();
  return ws;
}

const isScripted = (e: ClientEvent) =>
  e.type === "response.create" &&
  (e.response as { metadata?: unknown } | undefined)?.metadata !== undefined;

beforeEach(() => {
  FakeSocket.last = null;
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scriptResponse", () => {
  const script = "What's your name?";
  const evt = scriptResponse(script);
  const response = evt.response as { instructions: string; metadata: unknown; input?: unknown };

  it("is a response.create carrying the script in per-response instructions", () => {
    expect(evt.type).toBe("response.create");
    expect(response.instructions).toContain(script);
    expect(response.instructions.trimEnd().endsWith(script)).toBe(true);
    expect(response.metadata).toEqual(SCRIPT_METADATA);
  });

  it("adds nothing to the conversation history — no input items", () => {
    expect(response.input).toBeUndefined();
  });

  it("keeps the script text exactly as typed", () => {
    const odd = '  Line one.\n"Quoted" — and 100% intact?  ';
    const r = scriptResponse(odd).response as { instructions: string };
    expect(r.instructions).toContain(odd);
  });
});

describe("RealtimeClient script control", () => {
  it("leaves the session prompt alone — the script is not in session.update", async () => {
    const { client } = makeClient(() => "Tell me about your weekend plans.");
    const ws = await connectAndOpen(client);

    const [update] = ws.sentOfType("session.update");
    const session = update.session as { instructions: string };
    expect(session.instructions).toBe(SYSTEM_PROMPT);
    expect(JSON.stringify(update)).not.toContain("weekend plans");
  });

  it("waits for session.created when the mic starts first", async () => {
    const { client } = makeClient(() => "What's your name?");
    const ws = await connectAndOpen(client);

    await client.startMic();
    expect(ws.sent.filter(isScripted)).toHaveLength(0);

    ws.receive({ type: "session.created", session: {} });
    expect(ws.sent.filter(isScripted)).toHaveLength(1);
  });

  it("waits for the mic when session.created comes first, and reads the box at send time", async () => {
    let script = "first draft";
    const { client } = makeClient(() => script);
    const ws = await connectAndOpen(client);

    ws.receive({ type: "session.created", session: {} });
    expect(ws.sent.filter(isScripted)).toHaveLength(0);

    script = "What's your name?";
    await client.startMic();
    const sent = ws.sent.filter(isScripted);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain("What's your name?");
    expect(JSON.stringify(sent[0])).not.toContain("first draft");
  });

  it("speaks once per connection — not again when the mic is toggled", async () => {
    const { client } = makeClient(() => "What's your name?");
    const ws = await connectAndOpen(client);
    ws.receive({ type: "session.created", session: {} });
    await client.startMic();
    await client.stopMic();
    await client.startMic();
    ws.receive({ type: "session.updated", session: {} });
    expect(ws.sent.filter(isScripted)).toHaveLength(1);
  });

  it("speaks again on a fresh connection", async () => {
    const { client } = makeClient(() => "What's your name?");
    const first = await connectAndOpen(client);
    first.receive({ type: "session.created", session: {} });
    await client.startMic();
    client.disconnect();
    await tick();

    const second = await connectAndOpen(client);
    expect(second).not.toBe(first);
    second.receive({ type: "session.created", session: {} });
    await client.startMic();
    expect(second.sent.filter(isScripted)).toHaveLength(1);
  });

  it("sends nothing for an empty script — the plain tutorial behaviour", async () => {
    const { client } = makeClient(() => "   ");
    const ws = await connectAndOpen(client);
    ws.receive({ type: "session.created", session: {} });
    await client.startMic();
    expect(ws.sentOfType("response.create")).toHaveLength(0);
  });

  it("interrupts a scripted turn exactly like any other: flush, truncate, no response.create", async () => {
    const { client, player, serverEvents } = makeClient(() => "What's your name?");
    const ws = await connectAndOpen(client);
    ws.receive({ type: "session.created", session: {} });
    await client.startMic();

    // The server answers the scripted response.create as a normal turn…
    ws.receive({
      type: "response.created",
      response: { id: "resp_script", status: "in_progress", metadata: { source: "script" } },
    });
    ws.receive({
      type: "response.output_item.added",
      response_id: "resp_script",
      item: { id: "item_script", type: "message", role: "assistant" },
    });
    ws.receive({
      type: "response.output_audio_transcript.delta",
      item_id: "item_script",
      delta: "What's your",
    });
    ws.receive({
      type: "response.output_audio.delta",
      item_id: "item_script",
      delta: "AAAAAAAA",
    });
    expect(player.enqueueBase64).toHaveBeenCalledWith("AAAAAAAA");

    // …and then the user talks over it.
    const createsBefore = ws.sentOfType("response.create").length;
    ws.receive({ type: "input_audio_buffer.speech_started", item_id: "item_user_1" });
    await tick();

    expect(player.flush).toHaveBeenCalledTimes(1);
    expect(ws.sentOfType("conversation.item.truncate")).toEqual([
      {
        type: "conversation.item.truncate",
        item_id: "item_script",
        content_index: 0,
        audio_end_ms: 1234,
      },
    ]);
    // The server's VAD starts the user's turn; the client must not ask for one.
    expect(ws.sentOfType("response.create")).toHaveLength(createsBefore);

    // And the transcript shows the scripted line, cut off, then the user.
    let state = emptyTranscript;
    for (const evt of serverEvents) state = transcriptReducer(state, evt, 0);
    const items = toList(state);
    expect(items.map((i) => i.kind)).toEqual(["assistant", "user"]);
    expect(items[0]).toMatchObject({ text: "What's your", status: "interrupted" });
  });
});
