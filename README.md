# Higgs Realtime API — a tutorial

A progressive, build-it-yourself tutorial that takes a web developer with no audio
experience from zero to a working browser voice assistant on the
[Higgs Realtime API](https://docs.boson.ai/models/higgs-realtime/overview).

You need to be comfortable with JavaScript/TypeScript, React, and `fetch`. You do **not**
need to know anything about audio programming, and you do not need to have used WebSockets
before — both are explained where they first come up.

## This fork: editable session instructions and live VAD events

Two additions to the finished app:

- **System instructions** box. Its text is the `instructions` in the first `session.update`
  on connect; **Send session.update** sends it again mid-session. Every `session.update`
  sent and every `session.created` / `session.updated` received is listed under the box.
- **Speech & transcription** panel. Lists `input_audio_buffer.speech_started`,
  `input_audio_buffer.speech_stopped` and
  `conversation.item.input_audio_transcription.completed` as they arrive.
- **Questions** box. Each time Alexa finishes a reply (`response.done`), the next question is
  sent in a new `session.update`, so it is in place before the server starts her next reply. After each transcription, Claude Haiku 5.5 (`POST /api/questions`
  in `server/index.ts`) edits the questions not yet asked. Needs `ANTHROPIC_API_KEY` in `.env`.

### Higgs Avatar (optional)

With **Use avatar** ticked, Connect first calls `POST /api/avatar/start` (`server/avatar.ts`):
it creates a LiveKit room, mints tokens, and starts a Boson avatar session
(`POST /v1/avatar/sessions`, built-in `builtin_claire_v1` by default). The browser joins the
room as the avatar's publisher (`agent`) and keeps its Higgs Realtime WebSocket as before;
Higgs's audio is streamed to the avatar (`src/avatar/AvatarLink.ts`, LiveKit byte stream
`lk.audio_stream`, 24 kHz PCM16 mono) instead of the local speaker, and the avatar's
lip-synced video and audio are played from the room. Barge-in sends `lk.clear_buffer` to
the avatar and truncates at the position its `lk.playback_finished` reports. Needs
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` in `.env`; without them the app
falls back to local playback.

### Consultant dashboard (`frontend/`)

`cd frontend && npm install && npm run dev` (with `npm run dev` running at the repo root for
`/api`). On an interview, **Send the interview** stores the call on the backend
(`server/interviews.ts`) and opens the interviewee's page (`/interview/<id>`) in a new tab.
The interviewee presses **Start interview**: that tab runs the call (microphone, Higgs
Realtime, avatar with sound) and publishes its state; the consultant's tab watches live over
Server-Sent Events (transcript, Claude's question changes, duration; no avatar) and
can end the call. Sessions are kept in memory.

**Findings** (dashboard): the investment thesis validation and the research gaps are written
by OpenAI GPT-6 (`POST /api/thesis-validation`, `server/validation.ts`) from the project's
thesis and hypotheses and the transcripts of completed interviews, in one call. Quotes are
checked against the transcripts. Needs `OPENAI_API_KEY` in `.env` (`OPENAI_MODEL` optional);
`npm run check:openai` confirms the key and the model.

## The parts

| Part | What you build | Checkpoint |
| --- | --- | --- |
| [0](docs/part-0.md) | A token endpoint that keeps your API key off the browser | `part-0` |
| [1](docs/part-1.md) | The first WebSocket connection — type a message, hear it answered | `part-1` |
| [2](docs/part-2.md) | Live microphone, server-side turn detection, and interruptions | `part-2` |
| [3](docs/part-3.md) | A correct transcript, out of an out-of-order event stream | `part-3` |
| [4](docs/part-4.md) | Tool calling — a dummy web search the model actually uses | `part-4` |
| [5](docs/part-5.md) | Prompting — a testable structure for the system prompt | `part-5` |

### With an agent framework

Parts 6 and 7 build the same agent on the server instead, with an open-source voice agent
framework. They are parallel tracks, not a sequence: pick the framework your stack
already uses. Both run the same Higgs Realtime agent on the production API, both come
with a browser playground
to talk to it, and neither depends on Parts 1–5. The agents need Python and
[uv](https://docs.astral.sh/uv/); Part 7's playground also needs Node.js and `pnpm`.

| Part | Framework | Run it | Talk to it in |
| --- | --- | --- | --- |
| [6](docs/part-6.md) | [Pipecat](https://docs.pipecat.ai/) | `cd pipecat && uv run bot.py` | the Pipecat playground at `http://localhost:7860` |
| [7](docs/part-7.md) | [LiveKit Agents](https://docs.livekit.io/agents/) | `livekit-server --dev`, then `cd livekit && uv run agent.py dev` | the LiveKit Agents Playground at `http://localhost:3000` |

Both agents call tools, a web search and the time, which run in your own process. Each
folder has a `.env.example` to copy to `.env` with your key, and a `probe.py` that places a
call headlessly and asks a question the agent can only answer with its search tool.

## Checkpoints

Every part is a git tag. To see the code as it stood at the end of any part:

```bash
git checkout part-1
npm install
npm run dev
```

`git checkout main` returns you to the latest state.

## Setup

```bash
npm install
cp .env.example .env    # then add your key
npm run dev
```

`npm run dev` starts the token server on `http://localhost:3000` and the Vite dev server
on `http://localhost:5173`. Open the second one.

[**How to use this repository**](docs/how-to-use.md) covers all of it in more detail —
driving the app, moving between the checkpoints, changing the catalogue and the prompt, and
what to do when something does not work.

## Other commands

```bash
npm test          # 31 unit tests
npm run typecheck # TypeScript, no emit
npm run build     # production build
npm run probe     # open a real session headlessly and print every event
```

`npm run probe` is the debugging instrument the tutorial builds alongside the app. It has no
audio hardware, which makes it the fastest way to tell a protocol bug from an audio bug — and
it can *speak*, synthesising an utterance and streaming it in exactly as the browser streams
microphone audio:

```bash
npm run probe -- --say "what's the weather this weekend in Willow Creek?"
```

## A note on scope

This is a teaching repository. It runs everything in the browser against local state, with
no database, no authentication, and no persistence — all of it resets on reload. Even the
web search is a dummy, on purpose: ten canned pages in one JSON file, which is what makes
"did the tool actually run?" checkable.
[Part 5](docs/part-5.md#beyond-the-tutorial) closes with what you would need to add before
any of this faces real users.

Every API fact in these pages was checked against the live documentation *and* against a
running session on 2026-08-07, with the read date recorded on each page. Several of them
contradict what the documentation says — those are called out where they occur, because
finding them is a large part of what building on a realtime API actually involves.
