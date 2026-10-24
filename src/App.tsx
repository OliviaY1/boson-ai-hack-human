import { useCallback, useEffect, useRef, useState } from "react";
import {
  RealtimeClient,
  type Activity,
  type ConnectionState,
  type LogEntry,
} from "./realtime/RealtimeClient";
import {
  emptyTranscript,
  transcriptReducer,
  type TranscriptState,
} from "./state/transcriptStore";
import { DebugDrawer } from "./ui/DebugDrawer";
import { MicButton } from "./ui/MicButton";
import { SessionPanel } from "./ui/SessionPanel";
import { VoiceEventsPanel } from "./ui/VoiceEventsPanel";
import { SpeechTimeline } from "./ui/SpeechTimeline";
import { StatusBar } from "./ui/StatusBar";
import { TranscriptPanel } from "./ui/TranscriptPanel";

/**
 * The default for the System instructions box. Higgs only replies after you
 * speak (server VAD starts each response), so the script is written as
 * replies to your turns.
 */
const DEFAULT_INSTRUCTIONS = `You are Alexa, a market researcher at Summit Ridge Capital, a private equity firm. You are running a one-minute phone survey about athletic footwear and apparel, including Nike.

Follow this script in order. Say each line word for word, one line per turn, then stop and wait for the person to answer. Never say "Hello! How can I assist you today?" Do not add anything that is not in the script.

1. Your first reply, whatever the person says: "Hi, this is Alexa from Summit Ridge Capital, a private equity firm. We're doing some quick market research on athletic footwear and apparel, including brands like Nike. It'll only take about one minute, and there are no right or wrong answers. Would it be okay if I asked you a few quick questions?"
   - If they say no: "No problem, thank you for your time. Have a great day!" Then stop.
2. "When you buy athletic shoes or clothes, which brand do you buy most often?"
3. "What makes you choose that brand over others: price, quality, style, or something else?"
4. "In the past year, have you been buying more Nike, less, or about the same? Why?"
5. "That's all I needed. Thank you so much for your time!"`;

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
  const [micActive, setMicActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [micStartAt, setMicStartAt] = useState<number | null>(null);
  // SYSTEM INSTRUCTIONS: sent in the first session.update on connect, and again
  // whenever "Send session.update" is pressed.
  const [instructions, setInstructions] = useState(DEFAULT_INSTRUCTIONS);
  const instructionsRef = useRef(instructions);
  instructionsRef.current = instructions;

  // The client outlives re-renders, so it lives in a ref rather than state.
  const clientRef = useRef<RealtimeClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new RealtimeClient({
      tokenProvider: fetchToken,
      instructionsProvider: () => instructionsRef.current,
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
        setTranscript((s) => transcriptReducer(s, evt, Date.now()));
      },
    });
  }

  useEffect(() => {
    const client = clientRef.current!;
    return () => void client.close();
  }, []);

  const connect = useCallback(async () => {
    setCloseMessage(null);
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

      <SessionPanel
        instructions={instructions}
        onChange={setInstructions}
        onSend={() => clientRef.current!.updateInstructions(instructions)}
        canSend={isOpen}
        entries={log}
      />

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

      <TranscriptPanel state={transcript} />

      <DebugDrawer entries={log} />
    </main>
  );
}
