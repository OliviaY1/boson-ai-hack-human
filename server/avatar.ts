import { createHmac, randomBytes } from "node:crypto";

/**
 * Higgs Avatar, server side: a LiveKit room, three access tokens, and the
 * Boson avatar session — following docs.boson.ai/models/higgs-avatar/realtime-sessions.
 *
 *   boson-avatar  the avatar. Publishes the lip-synced video and audio.
 *   agent         the browser tab. Keeps its own Higgs Realtime WebSocket and
 *                 sends Higgs's audio to the avatar over a LiveKit data stream
 *                 (it is the avatar's `publisher_identity`). Subscribes to the
 *                 avatar's tracks to show and play them.
 *
 * LiveKit tokens are plain HS256 JWTs signed with the API secret, so they are
 * minted here with node:crypto rather than an extra SDK dependency.
 */

export const AVATAR_IDENTITY = "boson-avatar";
export const PUBLISHER_IDENTITY = "agent";

export interface LiveKitConfig {
  url: string; // wss://<project>.livekit.cloud
  apiKey: string;
  apiSecret: string;
}

export function loadLiveKitConfig(): LiveKitConfig | null {
  const url = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  return url && apiKey && apiSecret ? { url, apiKey, apiSecret } : null;
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

interface TokenOptions {
  identity: string;
  ttlSeconds: number;
  video: Record<string, unknown>;
  kind?: string;
  attributes?: Record<string, string>;
}

/** A LiveKit access token (HS256 JWT). */
export function liveKitToken(cfg: LiveKitConfig, opts: TokenOptions): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: cfg.apiKey,
    sub: opts.identity,
    name: opts.identity,
    nbf: now - 10,
    exp: now + opts.ttlSeconds,
    video: opts.video,
  };
  if (opts.kind) claims.kind = opts.kind;
  if (opts.attributes) claims.attributes = opts.attributes;
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac("sha256", cfg.apiSecret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/** wss://x.livekit.cloud -> https://x.livekit.cloud, for the server API. */
const httpUrl = (wsUrl: string) => wsUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/$/, "");

/** RoomService.CreateRoom over LiveKit's Twirp HTTP API. */
async function createRoom(cfg: LiveKitConfig, name: string): Promise<void> {
  const token = liveKitToken(cfg, {
    identity: "server",
    ttlSeconds: 60,
    video: { roomCreate: true },
  });
  const res = await fetch(`${httpUrl(cfg.url)}/twirp/livekit.RoomService/CreateRoom`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    // emptyTimeout: seconds the room stays open with nobody in it.
    body: JSON.stringify({ name, emptyTimeout: 120 }),
  });
  if (!res.ok) throw new HttpError(res.status, `LiveKit CreateRoom ${res.status}: ${await res.text()}`);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter?: string | null,
  ) {
    super(message);
  }
}

export interface AvatarStartResult {
  sessionId: string;
  avatarId: string;
  url: string;
  roomName: string;
  /** For the browser, joining as PUBLISHER_IDENTITY. */
  token: string;
  avatarIdentity: string;
  publisherIdentity: string;
  expiresAt: unknown;
}

/**
 * Create the room, mint the tokens, and start the Boson avatar session.
 * Boson answers 201 once the avatar has joined the room.
 */
export async function startAvatar(opts: {
  boson: { baseUrl: string; apiKey: string };
  livekit: LiveKitConfig;
  avatarId: string;
  maxDurationSeconds: number;
}): Promise<AvatarStartResult> {
  const { livekit, boson, avatarId, maxDurationSeconds } = opts;
  const roomName = `higgs-avatar-${randomBytes(6).toString("hex")}`;
  await createRoom(livekit, roomName);

  // The avatar's token must outlive the session.
  const ttl = maxDurationSeconds + 600;
  const avatarToken = liveKitToken(livekit, {
    identity: AVATAR_IDENTITY,
    ttlSeconds: ttl,
    kind: "agent",
    attributes: { "lk.publish_on_behalf": PUBLISHER_IDENTITY },
    video: {
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: false,
      canPublishData: true,
      canPublishSources: ["camera", "microphone"],
    },
  });
  const browserToken = liveKitToken(livekit, {
    identity: PUBLISHER_IDENTITY,
    ttlSeconds: ttl,
    video: {
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
  });

  const body = JSON.stringify({
    avatar_id: avatarId,
    transport: {
      type: "livekit",
      url: livekit.url,
      room_name: roomName,
      participant_token: avatarToken,
      participant_identity: AVATAR_IDENTITY,
      publisher_identity: PUBLISHER_IDENTITY,
    },
    max_duration_seconds: maxDurationSeconds,
  });

  // No free slot (429 capacity_exhausted / rate_limit_error) or a transient 503:
  // Boson says how long to wait in Retry-After. Try again a few times before
  // giving up (the call then continues voice only). insufficient_quota is a
  // billing problem, so it is not retried.
  const MAX_ATTEMPTS = 4;
  let res: Response | null = null;
  let text = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await fetch(`${boson.baseUrl}/v1/avatar/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${boson.apiKey}`, "Content-Type": "application/json" },
      body,
    });
    text = await res.text();
    const retryable =
      (res.status === 429 && !text.includes("insufficient_quota")) || res.status === 503;
    if (res.ok || !retryable || attempt === MAX_ATTEMPTS) break;
    const after = Number(res.headers.get("retry-after"));
    const waitS = Math.min(Number.isFinite(after) && after > 0 ? after : 3, 10);
    console.warn(`avatar: no free slot (HTTP ${res.status}); retrying in ${waitS}s (${attempt}/${MAX_ATTEMPTS - 1})`);
    await new Promise((r) => setTimeout(r, waitS * 1000));
  }
  if (!res || !res.ok) {
    const status = res?.status ?? 502;
    throw new HttpError(
      status,
      `Avatar session ${status} after ${MAX_ATTEMPTS} tries: ${text}`,
      res?.headers.get("retry-after"),
    );
  }
  const session = JSON.parse(text) as { id: string; expires_at?: unknown };
  return {
    sessionId: session.id,
    avatarId,
    url: livekit.url,
    roomName,
    token: browserToken,
    avatarIdentity: AVATAR_IDENTITY,
    publisherIdentity: PUBLISHER_IDENTITY,
    expiresAt: session.expires_at,
  };
}

/** End the avatar session. Boson also ends it at expires_at or when the room empties. */
export async function stopAvatar(boson: { baseUrl: string; apiKey: string }, sessionId: string): Promise<unknown> {
  const res = await fetch(`${boson.baseUrl}/v1/avatar/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${boson.apiKey}` },
  });
  const text = await res.text();
  if (!res.ok && res.status !== 404) throw new HttpError(res.status, `Avatar delete ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

