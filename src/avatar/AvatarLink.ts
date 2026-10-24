/**
 * Higgs Avatar, browser side.
 *
 * The browser joins the avatar's LiveKit room as the avatar's publisher
 * ("agent"). It keeps its own Higgs Realtime WebSocket exactly as before; the
 * only change is where Higgs's audio goes: instead of the local speaker, it is
 * streamed to the avatar, which lip-syncs it and publishes video + audio back
 * into the room. We play only those tracks, so there is no duplicate audio.
 *
 * The wire protocol is LiveKit Agents' avatar data-stream protocol, the one
 * Boson's guide uses (DataStreamAudioOutput in livekit-agents):
 *   audio      byte stream, topic "lk.audio_stream", one stream per utterance,
 *              attributes { sample_rate, num_channels }, raw PCM16 bytes
 *   interrupt  RPC "lk.clear_buffer" to the avatar
 *   callbacks  RPCs "lk.playback_started" / "lk.playback_finished" from the
 *              avatar; the latter carries { playback_position, interrupted }
 *
 * livekit-client is loaded from the CDN URL Boson's guide uses, so the app
 * gains no npm dependency.
 */

const LIVEKIT_CLIENT_URL = "https://unpkg.com/livekit-client@2.15.0/dist/livekit-client.umd.js";

const AUDIO_STREAM_TOPIC = "lk.audio_stream";
const RPC_CLEAR_BUFFER = "lk.clear_buffer";
const RPC_PLAYBACK_FINISHED = "lk.playback_finished";
const RPC_PLAYBACK_STARTED = "lk.playback_started";

/** Higgs Realtime output: 24 kHz, 16-bit, mono (see AUDIO_RATE in sessionConfig.ts). */
const SAMPLE_RATE = "24000";
const NUM_CHANNELS = "1";

// --- the slice of livekit-client this file uses -------------------------------

interface LkTrack {
  kind: string;
  attach(): HTMLMediaElement;
  detach(): HTMLMediaElement[];
}
interface LkParticipant {
  identity: string;
}
interface LkByteStreamWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
interface LkRpcInvocationData {
  callerIdentity: string;
  payload: string;
}
interface LkRoom {
  connect(url: string, token: string): Promise<void>;
  disconnect(): Promise<void>;
  startAudio(): Promise<void>;
  on(event: string, listener: (...args: never[]) => void): LkRoom;
  registerRpcMethod(method: string, handler: (data: LkRpcInvocationData) => Promise<string>): void;
  localParticipant: {
    streamBytes(options: {
      name?: string;
      topic?: string;
      attributes?: Record<string, string>;
      destinationIdentities?: string[];
    }): Promise<LkByteStreamWriter>;
    performRpc(params: {
      destinationIdentity: string;
      method: string;
      payload: string;
      responseTimeout?: number;
    }): Promise<string>;
  };
}
interface LkModule {
  Room: new (options?: Record<string, unknown>) => LkRoom;
  RoomEvent: { TrackSubscribed: string; ParticipantDisconnected: string; Disconnected: string };
}

declare global {
  interface Window {
    LivekitClient?: LkModule;
  }
}

let lkPromise: Promise<LkModule> | null = null;

function loadLiveKit(): Promise<LkModule> {
  if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
  if (lkPromise) return lkPromise;
  lkPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = LIVEKIT_CLIENT_URL;
    s.async = true;
    s.onload = () =>
      window.LivekitClient ? resolve(window.LivekitClient) : reject(new Error("livekit-client did not load"));
    s.onerror = () => {
      lkPromise = null;
      reject(new Error(`could not load ${LIVEKIT_CLIENT_URL}`));
    };
    document.head.appendChild(s);
  });
  return lkPromise;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- the link -----------------------------------------------------------------

export interface AvatarCallbacks {
  /** Where the avatar's <video> and <audio> elements go. */
  mediaContainer: HTMLElement;
  /** The avatar finished (or was cut off in) an utterance. */
  onPlaybackFinished?: (info: { positionMs: number; interrupted: boolean }) => void;
  /** The room or the avatar went away. */
  onEnded?: (reason: string) => void;
  onLog?: (message: string) => void;
}

interface StartResponse {
  sessionId: string;
  url: string;
  roomName: string;
  token: string;
  avatarIdentity: string;
  publisherIdentity: string;
  error?: string;
}

export class AvatarLink {
  readonly sessionId: string;
  readonly roomName: string;
  private readonly avatarIdentity: string;
  private readonly room: LkRoom;
  private readonly cb: AvatarCallbacks;
  private readonly elements: HTMLMediaElement[] = [];

  /** The open byte stream for the current utterance, if any. */
  private writer: LkByteStreamWriter | null = null;
  /** Writes run one after another, in order. */
  private chain: Promise<void> = Promise.resolve();
  /** Bumped on every clear: queued writes from before it are dropped. */
  private generation = 0;
  /** Resolvers waiting for the playback_finished that follows a clear. */
  private clearWaiters: Array<(ms: number | null) => void> = [];
  private closed = false;

  private constructor(start: StartResponse, room: LkRoom, cb: AvatarCallbacks) {
    this.sessionId = start.sessionId;
    this.roomName = start.roomName;
    this.avatarIdentity = start.avatarIdentity;
    this.room = room;
    this.cb = cb;
  }

  /**
   * Start an avatar session (server: room + tokens + Boson session), join the
   * room, and wait until the avatar's audio track is playing here.
   */
  static async start(avatarId: string, cb: AvatarCallbacks): Promise<AvatarLink> {
    const res = await fetch("/api/avatar/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatarId }),
    });
    const start = (await res.json()) as StartResponse;
    if (!res.ok) throw new Error(start.error ?? `avatar start HTTP ${res.status}`);
    cb.onLog?.(`avatar session ${start.sessionId} in room ${start.roomName}`);

    let lk: LkModule;
    try {
      lk = await loadLiveKit();
    } catch (e) {
      await stopSession(start.sessionId);
      throw e;
    }
    const room = new lk.Room({ adaptiveStream: true });
    const link = new AvatarLink(start, room, cb);
    try {
      await link.join(lk, start);
    } catch (e) {
      await link.close();
      throw e;
    }
    return link;
  }

  private async join(lk: LkModule, start: StartResponse): Promise<void> {
    const ev = lk.RoomEvent;

    // RPCs from the avatar. Register before connecting so none are missed.
    this.room.registerRpcMethod(RPC_PLAYBACK_STARTED, async (data) =>
      data.callerIdentity === this.avatarIdentity ? "ok" : "reject",
    );
    this.room.registerRpcMethod(RPC_PLAYBACK_FINISHED, async (data) => {
      if (data.callerIdentity !== this.avatarIdentity) return "reject";
      let positionMs = 0;
      let interrupted = false;
      try {
        const p = JSON.parse(data.payload) as { playback_position?: number; interrupted?: boolean };
        positionMs = Math.round((p.playback_position ?? 0) * 1000);
        interrupted = Boolean(p.interrupted);
      } catch {
        /* keep the defaults */
      }
      for (const resolve of this.clearWaiters.splice(0)) resolve(positionMs);
      this.cb.onPlaybackFinished?.({ positionMs, interrupted });
      return "ok";
    });

    const audioReady = new Promise<void>((resolve) => {
      this.room.on(ev.TrackSubscribed, ((track: LkTrack, _pub: unknown, participant: LkParticipant) => {
        if (participant.identity !== this.avatarIdentity) return;
        const el = track.attach();
        el.autoplay = true;
        if (track.kind === "video") {
          (el as HTMLVideoElement).playsInline = true;
          el.muted = true; // the sound comes from the audio track
          el.className = "avatar-video";
        } else {
          el.style.display = "none";
          resolve();
        }
        this.elements.push(el);
        this.cb.mediaContainer.appendChild(el);
      }) as (...args: never[]) => void);
    });
    this.room.on(ev.ParticipantDisconnected, ((p: LkParticipant) => {
      if (p.identity === this.avatarIdentity) this.cb.onEnded?.("the avatar left the room");
    }) as (...args: never[]) => void);
    this.room.on(ev.Disconnected, (() => {
      if (!this.closed) this.cb.onEnded?.("disconnected from the room");
    }) as (...args: never[]) => void);

    await this.room.connect(start.url, start.token);
    // Allowed because Connect was a click; without it the avatar is silent.
    await this.room.startAudio().catch(() => undefined);

    // Like the guide's wait_remote_track=KIND_AUDIO: send nothing until the
    // avatar's audio track is here.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      audioReady,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the avatar's audio track did not arrive within 30 s")), 30_000);
      }),
    ]).finally(() => clearTimeout(timer));
    this.cb.onLog?.("avatar audio and video are live");
  }

  /** One response.output_audio.delta (base64 PCM16, 24 kHz mono) → the avatar. */
  pushAudio(b64: string): void {
    if (this.closed || !b64) return;
    const bytes = base64ToBytes(b64);
    const gen = this.generation;
    this.chain = this.chain
      .then(async () => {
        if (gen !== this.generation || this.closed) return;
        if (!this.writer) {
          this.writer = await this.room.localParticipant.streamBytes({
            name: `AUDIO_${Math.random().toString(36).slice(2, 10)}`,
            topic: AUDIO_STREAM_TOPIC,
            destinationIdentities: [this.avatarIdentity],
            attributes: { sample_rate: SAMPLE_RATE, num_channels: NUM_CHANNELS },
          });
        }
        if (gen !== this.generation) return;
        await this.writer.write(bytes);
      })
      .catch((e) => this.cb.onLog?.(`avatar audio write failed: ${errText(e)}`));
  }

  /** End of an utterance: close its byte stream (the protocol's segment end). */
  endSegment(): void {
    const gen = this.generation;
    this.chain = this.chain
      .then(async () => {
        if (gen !== this.generation || !this.writer) return;
        const w = this.writer;
        this.writer = null;
        await w.close();
      })
      .catch((e) => this.cb.onLog?.(`avatar stream close failed: ${errText(e)}`));
  }

  /**
   * Barge-in: drop everything not yet sent, and tell the avatar to stop.
   * Resolves with how far it got (ms, from its playback_finished), or null if
   * it did not say within 2 s.
   */
  clear(): Promise<number | null> {
    this.generation++;
    const w = this.writer;
    this.writer = null;
    if (w) this.chain = this.chain.then(() => w.close()).catch(() => undefined);

    const finished = new Promise<number | null>((resolve) => {
      this.clearWaiters.push(resolve);
      setTimeout(() => {
        const i = this.clearWaiters.indexOf(resolve);
        if (i >= 0) {
          this.clearWaiters.splice(i, 1);
          resolve(null);
        }
      }, 2000);
    });
    void this.room.localParticipant
      .performRpc({ destinationIdentity: this.avatarIdentity, method: RPC_CLEAR_BUFFER, payload: "" })
      .catch((e) => this.cb.onLog?.(`avatar clear_buffer failed: ${errText(e)}`));
    return finished;
  }

  /** Leave the room and end the Boson session. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    for (const resolve of this.clearWaiters.splice(0)) resolve(null);
    await this.writer?.close().catch(() => undefined);
    this.writer = null;
    await this.room.disconnect().catch(() => undefined);
    for (const el of this.elements.splice(0)) el.remove();
    await stopSession(this.sessionId);
    this.cb.onLog?.(`avatar session ${this.sessionId} ended`);
  }
}

async function stopSession(sessionId: string): Promise<void> {
  await fetch("/api/avatar/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
    keepalive: true,
  }).catch(() => undefined);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
