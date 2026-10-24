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

  const res = await fetch(`${boson.baseUrl}/v1/avatar/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${boson.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
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
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    // 429 capacity_exhausted / rate_limit_error and 503 come with Retry-After.
    throw new HttpError(res.status, `Avatar session ${res.status}: ${text}`, res.headers.get("retry-after"));
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

/**
 * A watch-only token for the consultant's tab: it may subscribe to the
 * avatar's video, and may not publish anything.
 */
export function viewerToken(cfg: LiveKitConfig, roomName: string, identity: string): string {
  return liveKitToken(cfg, {
    identity,
    ttlSeconds: 2 * 60 * 60,
    video: { roomJoin: true, room: roomName, canPublish: false, canPublishData: false, canSubscribe: true },
  });
}
