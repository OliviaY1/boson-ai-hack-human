import { randomBytes } from "node:crypto";
import type { Express, Response } from "express";
import { loadLiveKitConfig, viewerToken } from "./avatar";

/**
 * Interview sessions shared between two tabs:
 *
 *   consultant  POST /api/interviews          create a session (the call's config)
 *               GET  /api/interviews/:id/events   watch it live (Server-Sent Events)
 *               POST /api/interviews/:id/end      ask the interviewee's tab to hang up
 *               POST /api/interviews/:id/viewer   watch-only LiveKit token for the avatar
 *   interviewee GET  /api/interviews/:id          load the config, then run the call
 *               POST /api/interviews/:id/state    publish the call's state as it changes
 *               GET  /api/interviews/:id/events   (also) hear the consultant's "end"
 *
 * The call itself (microphone, Higgs Realtime, avatar audio) runs in the
 * interviewee's tab; this only relays. Sessions live in memory, so a server
 * restart forgets them.
 */

interface Session {
  id: string;
  createdAt: number;
  /** Whatever the consultant's tab sent: the CallController config and display names. */
  config: unknown;
  display: unknown;
  /** The latest CallState from the interviewee's tab. */
  state: unknown;
  endRequested: boolean;
  watchers: Set<Response>;
}

const sessions = new Map<string, Session>();
const MAX_SESSIONS = 200;

function snapshot(s: Session) {
  return { id: s.id, createdAt: s.createdAt, display: s.display, state: s.state, endRequested: s.endRequested };
}

function broadcast(s: Session): void {
  const data = `data: ${JSON.stringify(snapshot(s))}\n\n`;
  for (const res of s.watchers) res.write(data);
}

export function registerInterviewRoutes(app: Express): void {
  app.post("/api/interviews", (req, res) => {
    const { config, display } = req.body ?? {};
    if (!config) return res.status(400).json({ error: "config required" });
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) sessions.delete(oldest.id);
    }
    const id = randomBytes(8).toString("hex");
    sessions.set(id, {
      id,
      createdAt: Date.now(),
      config,
      display: display ?? {},
      state: null,
      endRequested: false,
      watchers: new Set(),
    });
    return res.json({ id });
  });

  app.get("/api/interviews/:id", (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "This interview link is not valid (or the server restarted)." });
    return res.json({ ...snapshot(s), config: s.config });
  });

  app.post("/api/interviews/:id/state", (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "unknown interview" });
    s.state = req.body?.state ?? null;
    broadcast(s);
    return res.json({ ok: true, endRequested: s.endRequested });
  });

  app.post("/api/interviews/:id/end", (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "unknown interview" });
    s.endRequested = true;
    broadcast(s);
    return res.json({ ok: true });
  });

  app.post("/api/interviews/:id/viewer", (req, res) => {
    const s = sessions.get(req.params.id);
    const livekit = loadLiveKitConfig();
    const roomName = String(req.body?.roomName ?? "");
    if (!s || !livekit || !roomName) return res.status(400).json({ error: "no avatar room to watch" });
    return res.json({
      url: livekit.url,
      token: viewerToken(livekit, roomName, `consultant-${randomBytes(3).toString("hex")}`),
    });
  });

  app.get("/api/interviews/:id/events", (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).end();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(snapshot(s))}\n\n`);
    s.watchers.add(res);
    // A comment line now and then keeps proxies from closing an idle stream.
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      s.watchers.delete(res);
    });
  });
}
