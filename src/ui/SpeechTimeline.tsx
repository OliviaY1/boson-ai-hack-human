import { useEffect, useState } from "react";
import type { LogEntry } from "../realtime/RealtimeClient";
import { SERVER } from "../realtime/events";

/**
 * A 10-second timeline that starts when the microphone starts.
 *
 * Each input_audio_buffer.speech_started / speech_stopped is placed at the
 * moment it ARRIVED in the browser, measured from microphone start. The
 * audio_start_ms / audio_end_ms values the server put in the event are shown
 * next to each marker.
 *
 * A started-without-stopped segment is drawn up to the playhead, so a bar grows
 * while you are talking.
 */
const WINDOW_MS = 10_000;

interface Marker {
  kind: "start" | "stop";
  t: number;
  serverMs: unknown;
}

export function SpeechTimeline({
  entries,
  micStartAt,
  micActive,
}: {
  entries: LogEntry[];
  micStartAt: number | null;
  micActive: boolean;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!micActive) return;
    let raf = 0;
    const tick = () => {
      setNow(Date.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [micActive]);

  const elapsed = micStartAt === null ? 0 : Math.min(WINDOW_MS, Math.max(0, now - micStartAt));
  const pct = (t: number) => `${(Math.min(WINDOW_MS, Math.max(0, t)) / WINDOW_MS) * 100}%`;

  const markers: Marker[] = [];
  if (micStartAt !== null) {
    for (const e of entries) {
      if (e.dir !== "recv" || e.at < micStartAt) continue;
      const raw = e.raw as { audio_start_ms?: unknown; audio_end_ms?: unknown } | null;
      if (e.type === SERVER.speechStarted) {
        markers.push({ kind: "start", t: e.at - micStartAt, serverMs: raw?.audio_start_ms });
      } else if (e.type === SERVER.speechStopped) {
        markers.push({ kind: "stop", t: e.at - micStartAt, serverMs: raw?.audio_end_ms });
      }
    }
  }

  // Pair each start with the next stop; an unpaired start runs to the playhead.
  const segments: Array<{ from: number; to: number }> = [];
  let open: number | null = null;
  for (const m of markers) {
    if (m.kind === "start") open = m.t;
    else if (open !== null) {
      segments.push({ from: open, to: m.t });
      open = null;
    }
  }
  if (open !== null) segments.push({ from: open, to: elapsed });

  return (
    <section className="timeline">
      <h2>You speaking — first 10 s after the microphone starts</h2>
      <div className="timeline-track">
        <div className="timeline-line" />
        {Array.from({ length: 11 }, (_, s) => (
          <div key={s} className="timeline-tick" style={{ left: pct(s * 1000) }}>
            <span>{s}s</span>
          </div>
        ))}
        {segments.map((seg, i) => (
          <div
            key={i}
            className="timeline-segment"
            style={{ left: pct(seg.from), width: `calc(${pct(seg.to)} - ${pct(seg.from)})` }}
          />
        ))}
        {markers.map((m, i) => (
          <div
            key={i}
            className={`timeline-marker marker-${m.kind}`}
            style={{ left: pct(m.t) }}
            title={`${m.kind === "start" ? "speech_started" : "speech_stopped"} received at ${(m.t / 1000).toFixed(2)}s`}
          >
            <span>
              {m.kind === "start" ? "start" : "stop"} {(m.t / 1000).toFixed(2)}s
              {typeof m.serverMs === "number" &&
                ` (${m.kind === "start" ? "audio_start_ms" : "audio_end_ms"} ${m.serverMs})`}
            </span>
          </div>
        ))}
        {micStartAt !== null && <div className="timeline-playhead" style={{ left: pct(elapsed) }} />}
      </div>
    </section>
  );
}
