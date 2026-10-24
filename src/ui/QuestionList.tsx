/**
 * The question list as Alexa works through it, with Claude's edits marked:
 *
 *   ✓ said      — Alexa has said it (her transcript matched it)
 *   ▶ next      — the one the next session.update will carry
 *   + added     — added by Claude, with the time
 *   − removed   — removed by Claude, struck through, kept for the record
 */
export interface RemovedQuestion {
  text: string;
  at: number;
}

const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour12: false });

export function QuestionList({
  questions,
  isSaid,
  addedAt,
  removed,
  updating,
}: {
  questions: string[];
  isSaid: (q: string) => boolean;
  addedAt: Record<string, number>;
  removed: RemovedQuestion[];
  updating: boolean;
}) {
  const nextIndex = questions.findIndex((q) => !isSaid(q));
  return (
    <section className="voice-events">
      <h2>Live question list {updating && <span className="qlist-updating">· Claude is updating…</span>}</h2>
      <ol className="qlist">
        {questions.map((q, i) => {
          const said = isSaid(q);
          const added = addedAt[q.toLowerCase()];
          return (
            <li
              key={`${q}-${i}`}
              className={`qrow ${said ? "q-said" : i === nextIndex ? "q-next" : ""} ${added ? "q-added" : ""}`}
            >
              <span className="qmark">{said ? "✓" : i === nextIndex ? "▶" : "·"}</span>
              <span className="qtext">{q}</span>
              {added && <span className="qtag">+ added {time(added)}</span>}
            </li>
          );
        })}
        {removed.map((r, i) => (
          <li key={`removed-${i}`} className="qrow q-removed">
            <span className="qmark">−</span>
            <span className="qtext">{r.text}</span>
            <span className="qtag">removed {time(r.at)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
