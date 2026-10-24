import { loadLiveKit } from "./AvatarLink";

/**
 * Watch-only view of a running avatar, for the consultant's tab: joins the
 * avatar's LiveKit room with a subscribe-only token and shows its VIDEO. Audio
 * tracks are never attached, so this tab makes no sound (the interviewee's tab
 * is the one that plays it).
 */
export class AvatarViewer {
  private room: { disconnect(): Promise<void> } | null = null;
  private readonly elements: HTMLMediaElement[] = [];

  static async watch(
    interviewId: string,
    roomName: string,
    container: HTMLElement,
    avatarIdentity = "boson-avatar",
  ): Promise<AvatarViewer> {
    const res = await fetch(`/api/interviews/${encodeURIComponent(interviewId)}/viewer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomName }),
    });
    const body = (await res.json()) as { url?: string; token?: string; error?: string };
    if (!res.ok || !body.url || !body.token) throw new Error(body.error ?? `HTTP ${res.status}`);

    const lk = await loadLiveKit();
    const viewer = new AvatarViewer();
    const room = new lk.Room({ adaptiveStream: true });
    room.on(lk.RoomEvent.TrackSubscribed, ((
      track: { kind: string; attach(): HTMLMediaElement },
      _pub: unknown,
      participant: { identity: string },
    ) => {
      if (participant.identity !== avatarIdentity || track.kind !== "video") return;
      const el = track.attach();
      el.muted = true;
      el.autoplay = true;
      (el as HTMLVideoElement).playsInline = true;
      viewer.elements.push(el);
      container.appendChild(el);
    }) as (...args: never[]) => void);
    await room.connect(body.url, body.token);
    viewer.room = room;
    return viewer;
  }

  async close(): Promise<void> {
    for (const el of this.elements.splice(0)) el.remove();
    const room = this.room;
    this.room = null;
    await room?.disconnect().catch(() => undefined);
  }
}
