import type { LogEntry } from "../realtime/RealtimeClient";

/**
 * The system instructions, editable, plus every session.update we sent and
 * every session.created / session.updated the server sent back.
 *
 * Built from the same log entries as the debug drawer, so there is no second
 * path for events: a session.update shows up here because RealtimeClient
 * logged it on the way out, and the ack shows up because it was logged on the
 * way in.
 */
const SESSION_TYPES = new Set(["session.update", "session.created", "session.updated"]);

function instructionsOf(raw: unknown): string | undefined {
  const session = (raw as { session?: { instructions?: unknown } } | null)?.session;
  return typeof session?.instructions === "string" ? session.instructions : undefined;
}

export function SessionPanel({
  instructions,
  onChange,
  onSend,
  canSend,
  entries,
}: {
  instructions: string;
  onChange: (text: string) => void;
  onSend: () => void;
  canSend: boolean;
  entries: LogEntry[];
}) {
  const events = entries.filter((e) => e.dir !== "info" && SESSION_TYPES.has(e.type));

  return (
    <section className="session">
      <label className="field">
        <span>System instructions (sent with session.update)</span>
        <textarea value={instructions} onChange={(e) => onChange(e.target.value)} rows={5} />
      </label>
      <div className="row">
        <button onClick={onSend} disabled={!canSend}>
          Send session.update
        </button>
      </div>

      {events.length > 0 && (
        <ol className="session-events">
          {events.map((e) => {
            const text = instructionsOf(e.raw);
            return (
              <li key={e.id} className="session-event">
                <div className="session-event-head">
                  <span className={`dir-${e.dir}`}>{e.dir === "send" ? "↑ sent" : "↓ received"}</span>
                  <code>{e.type}</code>
                  <span className="time">
                    {new Date(e.at).toLocaleTimeString(undefined, { hour12: false })}
                  </span>
                </div>
                {/* Only what we sent; the server's ack would repeat the same text. */}
                {e.dir === "send" && text !== undefined && <pre>{text}</pre>}
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
