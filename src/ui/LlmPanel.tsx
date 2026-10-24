/**
 * Every call to Claude that updates the question list: exactly what was sent
 * (model, system prompt, user message, as echoed back by the server) and what
 * came back (the raw reply and the add / remove it was parsed into).
 */
export interface LlmCall {
  id: number;
  at: number;
  status: "pending" | "ok" | "error";
  model?: string;
  system?: string;
  user?: string;
  raw?: string;
  add?: string[];
  remove?: string[];
  error?: string;
  ms?: number;
}

export function LlmPanel({ calls }: { calls: LlmCall[] }) {
  return (
    <section className="voice-events">
      <h2>Claude question updates</h2>
      {calls.length === 0 ? (
        <p className="empty">No calls yet — one is made after each transcription of your speech.</p>
      ) : (
        <ol className="session-events">
          {[...calls].reverse().map((c) => (
            <li key={c.id} className="session-event">
              <div className="session-event-head">
                <span className={c.status === "error" ? "dir-error" : "dir-send"}>
                  {c.status === "pending" ? "… waiting" : c.status === "ok" ? "✓ done" : "✗ error"}
                </span>
                {c.model && <code>{c.model}</code>}
                {c.ms !== undefined && <span>{c.ms} ms</span>}
                <span className="time">
                  {new Date(c.at).toLocaleTimeString(undefined, { hour12: false })}
                </span>
              </div>
              {c.status === "ok" && (
                <div className="session-event-fields">
                  add: {c.add?.length ? c.add.join(" | ") : "—"} · remove:{" "}
                  {c.remove?.length ? c.remove.join(" | ") : "—"}
                </div>
              )}
              {c.error && <pre>{c.error}</pre>}
              {c.raw !== undefined && (
                <details open>
                  <summary>Output</summary>
                  <pre>{c.raw}</pre>
                </details>
              )}
              {c.system !== undefined && (
                <details>
                  <summary>Prompt</summary>
                  <pre>{`[system]\n${c.system}\n\n[user]\n${c.user ?? ""}`}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
