import type { LogEntry } from "../realtime/RealtimeClient";
import { SERVER } from "../realtime/events";

/**
 * The server's turn-detection and transcription events, live:
 *
 *   input_audio_buffer.speech_started   — VAD heard you start talking
 *   input_audio_buffer.speech_stopped   — VAD heard you stop
 *   conversation.item.input_audio_transcription.completed — the text of what you said
 *
 * Built from the same log entries as the debug drawer. Each row shows the
 * fields the event actually carried; the full event is one click away.
 */
const LABELS: Record<string, string> = {
  [SERVER.speechStarted]: "started speaking",
  [SERVER.speechStopped]: "stopped speaking",
  [SERVER.transcriptionCompleted]: "transcription",
};

function fieldsOf(raw: unknown): string {
  const evt = (raw ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["audio_start_ms", "audio_end_ms", "item_id"]) {
    if (evt[key] !== undefined && evt[key] !== null) parts.push(`${key}: ${String(evt[key])}`);
  }
  return parts.join(" · ");
}

export function VoiceEventsPanel({ entries }: { entries: LogEntry[] }) {
  const events = entries.filter((e) => e.dir === "recv" && e.type in LABELS);

  return (
    <section className="voice-events">
      <h2>Speech &amp; transcription</h2>
      {events.length === 0 ? (
        <p className="empty">Nothing yet — start the microphone and talk.</p>
      ) : (
        <ol className="session-events">
          {events.map((e) => {
            const transcript = (e.raw as { transcript?: unknown } | null)?.transcript;
            return (
              <li key={e.id} className="session-event">
                <div className="session-event-head">
                  <span className="dir-recv">↓ {LABELS[e.type]}</span>
                  <code>{e.type}</code>
                  <span className="time">
                    {new Date(e.at).toLocaleTimeString(undefined, { hour12: false })}
                  </span>
                </div>
                {typeof transcript === "string" && <pre>{transcript}</pre>}
                {fieldsOf(e.raw) && <div className="session-event-fields">{fieldsOf(e.raw)}</div>}
                <details>
                  <summary>Full event</summary>
                  <pre>{JSON.stringify(e.raw, null, 2)}</pre>
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
