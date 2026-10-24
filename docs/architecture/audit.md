# Architecture audit

Audit date: **2026-10-24**. Source snapshot: **`f212a7046a2a4b66b4967c57d0528c4016737bf2`**. Scope covers the dashboard, Express API, shared voice/audio/avatar engine, original debug app, Python alternatives, dependency/build configuration, tests and CI.

The prototype has useful component boundaries and working offline test/build baselines. Its main architectural weakness is ownership: project history belongs to one browser, active calls belong to another browser, and the server accepts unversioned snapshots without authenticated roles. Several transitions between those owners can lose evidence, retain obsolete analysis, or outlive the call that created them.

No application fixes were made. Recommendations below are future work, not a description of functionality already present. Source links and line numbers refer to the audited commit. [Verification](verification.md) separates executed checks from static findings and timing-dependent risks.

The latest recheck includes five commits after the original `9a82ca0` audit. Background polling improves closed-sheet completion recovery, generic plans now include every selected contact, backend response errors are clearer, model fallback excludes named non-chat variants, and an optional manual OpenAI smoke workflow was added. None of A01-A18 is fully resolved. A19 records an additional reproduced validation race exposed by changes to evidence during an in-flight request.

## Priorities

“High” means a material confidentiality, resource-lifecycle, evidence-integrity or core-workflow issue. Exposure-dependent findings explicitly say when they apply. “Medium” means a correctness, continuity or deployment gap with a bounded trigger. This is a source/runtime-boundary audit, not a dependency vulnerability scan or load test.

| ID | Priority | Finding | Evidence level |
| --- | --- | --- | --- |
| A01 | High when exposed to untrusted users | Provider-backed operations have no access or spend controls | Source inspection |
| A02 | High for confidential research | Participant link also grants config, state-write and termination access | Local HTTP reproduction |
| A03 | High | Mirroring a snapshot causes an SSE reconnect feedback loop | Real hook with mocked EventSource |
| A04 | High | Validation cache can treat materially changed inputs as current | Local function reproduction |
| A05 | High | Creating a new round can freeze unfinished archived interviews | Local state-transition reproduction |
| A06 | High | Remote closure leaves capture running; hang-up does not flush local playback | Source control flow |
| A07 | Medium | In-flight startup can acquire resources after stop/disposal | Timing-dependent source race |
| A08 | Medium | Generated words are counted as questions heard by the participant | Source state model |
| A09 | Medium | Adaptive revisions can lag installed instructions or apply out of order | Source ordering/concurrency |
| A10 | Medium | Dropping invalid quotes does not revise the model's conclusion/confidence | Stubbed-provider reproduction |
| A11 | Medium | Session relay is volatile, evicts oldest sessions and accepts reordered snapshots | Source + capacity reproduction |
| A12 | Medium | Historical Findings and printable reports diverge from real research | Source + local round fixture |
| A13 | Medium | Contact deletion and reapproval can break research references | Source state transitions |
| A14 | Medium | API boundaries lack schemas and explicit deadlines | Source inspection |
| A15 | Medium beyond a local demo | Builds do not supply the separate API's production deployment/routing | Builds + configuration inspection |
| A16 | Medium | Full frontend typecheck fails; CI filters diagnostics and lacks live-boundary tests | Executed checks + CI inspection |
| A17 | Medium for sustained/team use | Browser persistence can overwrite changes and has no migration/write recovery | Source inspection |
| A18 | Medium for reproducible deployment | Alternate tracks and runtime CDN dependency need independent compatibility checks | Lock/config inspection |
| A19 | Medium | A new evidence revision can be marked tried without launching validation | Deferred-response hook reproduction |

## Access, evidence and state ownership

### A01 — Provider-backed operations have no access or spend controls

The Express entry installs a JSON parser and registers provider/session routes without authentication, authorization, rate limits or per-project quotas. A caller able to reach it can mint ephemeral Boson credentials, start avatars and invoke the configured LLM APIs using server-held keys. Keeping the long-lived keys out of the browser is valuable, but does not authorize these operations. The 2 MB body cap limits request size, not cost or concurrency.

Evidence: [server/index.ts:44](../../server/index.ts#L44), [token minting:163](../../server/index.ts#L163), [avatar start:301](../../server/index.ts#L301), [validation:204](../../server/validation.ts#L205). The API listener does not explicitly restrict its host ([index.ts:346](../../server/index.ts#L346)).

Follow-up: establish authenticated project ownership and a narrowly scoped participant capability, then apply per-user/project rate, concurrency and spend limits. Keep the controlled local-demo assumption explicit until that exists.

### A02 — A participant link grants broad access and reveals the research config

The same session ID reads the complete config, replaces arbitrary CallState, subscribes to snapshots and requests termination. It is a random capability, but there is no separation between participant and consultant permissions. The participant receives the full interview goal, which includes the thesis; hiding the dashboard UI does not keep that information from the browser.

A credential-free HTTP reproduction confirmed all four operations using only the session ID, including a synthetic state overwrite. Evidence: [server/interviews.ts:64](../../server/interviews.ts#L64), [state writes:70](../../server/interviews.ts#L70), [termination:78](../../server/interviews.ts#L78), [subscription:86](../../server/interviews.ts#L86), [goal construction](../../frontend/src/components/live-call.tsx#L54).

Follow-up: separate owner and participant capabilities; return only the configuration the participant needs. Make the policy for sharing investment assumptions explicit. Bind accepted state to a session owner and a monotonically increasing revision.

### A03 — Snapshot mirroring triggers repeated SSE reconnections

`LivePage` creates `setIv` inline. Mirroring state updates the project store, rerendering that parent and replacing the callback. `useLiveCall.flush` depends on the callback; its EventSource effect depends on `flush`. Consequently each mirror closes/reopens the stream. The server sends its current snapshot immediately on every subscription, which is mirrored again. Ended snapshots flush immediately, producing a tight feedback loop; live snapshots schedule another mirror after 250 ms.

This was reproduced with the actual hook, a parent using the same inline-updater pattern, and an EventSource stub that returns an initial ended snapshot. No real SSE service or provider was needed. A child-only `setSnap` rerender is not the cause; the project-store write and parent callback replacement are.

Evidence: [inline updater](../../frontend/src/routes/projects.$projectId.live.tsx#L92), [flush/effect dependencies](../../frontend/src/components/live-call.tsx#L123), [immediate initial snapshot](../../server/interviews.ts#L94).

Follow-up: stabilize the updater/subscription ownership and skip unchanged snapshots. Keep session synchronization independent of the detail panel's render lifecycle.

### A04 — Validation cache misses material content changes

The cache fingerprint includes thesis length/first 40 characters, hypothesis IDs/titles, transcript turn counts and final-text length. The submitted payload contains substantially more: the full thesis, company, hypothesis descriptions/evidence, participant metadata, question state and full transcript text. Equal-length edits after thesis character 40, or equal-length answer replacements, can preserve the key and suppress automatic reassessment.

Both collisions were reproduced with the exported `validationInputKey`. The Overview thesis editor makes the first trigger a normal user action. Evidence: [fingerprint](../../frontend/src/lib/thesis-validation.ts#L19), [actual payload](../../frontend/src/lib/thesis-validation.ts#L30), [cache gate](../../frontend/src/lib/thesis-validation.ts#L96), [thesis editor](../../frontend/src/routes/projects.$projectId.index.tsx#L100).

Follow-up: derive a canonical fingerprint from the complete submitted payload. Associate each response with that revision and reject a response that has become obsolete while in flight. Base next-round proposals on the same explicit revision.

### A05 — Starting another round freezes unfinished interviews

Next-round eligibility requires only one completed interview. Creating it archives the entire current interview array, including active/invited interviews, then empties `project.interviews`. Dashboard live updates map only that current array. A participant can continue a call while its archived dashboard record stops advancing; the incomplete interview is then omitted from validation.

A local fixture confirmed the active interview survives in `pastRounds` and cannot be changed by the current-only updater. Evidence: [eligibility](../../frontend/src/lib/mock-service.ts#L52), [archive transition](../../frontend/src/lib/next-round.ts#L139), [current-only writes](../../frontend/src/routes/projects.$projectId.live.tsx#L92).

The newer background poller also scans only `project.interviews`, so it does not recover those archived sessions ([useSyncSessions](../../frontend/src/components/live-call.tsx#L360)).

Follow-up: explicitly finish/cancel remaining sessions before archiving, or make interview/session updates work across current and historical rounds. Model “archived” separately from “completed”.

## Voice and question orchestration

### A06 — Closed calls can retain capture or queued speech

The WebSocket `onclose` path updates connection/activity state but does not stop MicCapture or flush RingPlayer. The controller's closed-state handler ends the call and closes its avatar without performing that missing capture teardown. Manual `disconnect` stops capture but also does not flush queued local audio; full player cleanup occurs only in `close`/disposal.

Trigger: a remote socket/network/session close while recording, or hang-up while generated local speech is queued. The UI can display ended while capture/processing remains active, or speech continues after hang-up. This is established by the cleanup paths; microphone hardware behavior was not exercised.

Evidence: [WebSocket close](../../src/realtime/RealtimeClient.ts#L246), [disconnect](../../src/realtime/RealtimeClient.ts#L258), [full close](../../src/realtime/RealtimeClient.ts#L299), [controller closed state](../../src/call/CallController.ts#L275).

Follow-up: one idempotent teardown should stop capture, flush output, cancel timers/requests and release avatar/socket resources before emitting final ended state.

### A07 — Stop does not cancel asynchronous startup

Startup awaits avatar creation, token acquisition, socket opening and microphone permission without checking whether that call was cancelled. Stop/dispose only releases resources already acquired. A pending await can later succeed and construct a socket, attach media or start capture, even restoring `phase:"live"` after the user left.

Evidence: [controller startup](../../src/call/CallController.ts#L207), [stop](../../src/call/CallController.ts#L247), [token await/socket creation](../../src/realtime/RealtimeClient.ts#L219), [mic permission await](../../src/audio/capture.ts#L50).

Follow-up: propagate an abort signal and call-generation identity through each await, releasing late results immediately. Cover audio initialization itself in startup error/finally handling; currently a rejected `player.resume` can strand the connection guard before token handling begins.

### A08 — Generated transcript completion is treated as audible completion

The controller marks matching pending questions as said on output-audio-transcript completion. Audio may still be buffered locally or by the avatar. The reducer only marks streaming assistant items interrupted; an item already marked complete by transcript generation is not corrected when barge-in occurs. An unheard question can therefore count as asked and its unplayed words can reach downstream analysis.

Evidence: [question status update](../../src/call/CallController.ts#L314), [interruption reducer](../../src/state/transcriptStore.ts#L131), [authoritative transcript completion](../../src/state/transcriptStore.ts#L336). The matching helper also uses unordered word membership rather than phrase order ([script.ts:43](../../src/call/script.ts#L43)).

Follow-up: track generated text, queued audio and confirmed audible progress separately, keyed to response/item identity. Reconcile question/transcript state after truncation.

### A09 — Adaptive question edits lack a shared response boundary

Each input STT completion launches an independent Anthropic request. At assistant `response.done`, the client installs the next question immediately. A later revision changes pending rows but does not replace the instruction already loaded in Higgs. Multiple revision requests can also return out of order or after stop/restart, with no generation/revision check.

Evidence: [refresh launch and mutation](../../src/call/CallController.ts#L322), [next-question installation](../../src/realtime/RealtimeClient.ts#L507), [HTTP request](../../src/call/script.ts#L77).

Follow-up: choose an explicit policy for whether the next response waits for adaptation. Version the pending queue and currently installed question; coalesce/serialize requests and reject results from older turns/calls.

Additional media/control risks are bounded by specific timing conditions:

- Avatar barge-in waits for an acknowledgement and then reads mutable `currentAssistantItemId`; a new response can replace the intended truncation target during that wait ([RealtimeClient.ts:565](../../src/realtime/RealtimeClient.ts#L565), [AvatarLink.ts:293](../../src/avatar/AvatarLink.ts#L293)). Capture the target identity before awaiting.
- The 15-second scripted-closing timer is not cleared by disconnect/reconnect and is not bound to its originating call; it can close a newer connection ([closing timer](../../src/realtime/RealtimeClient.ts#L343), [endNow](../../src/realtime/RealtimeClient.ts#L408)).
- Avatar stream-write failures are logged without necessarily detaching the sink, so a connected room can continue receiving routed output that never becomes audible ([AvatarLink.ts:253](../../src/avatar/AvatarLink.ts#L253), [controller callbacks](../../src/call/CallController.ts#L360)).
- The local playback ring overwrites old audio after 12 seconds without drop telemetry; the played counter then no longer represents a contiguous heard prefix ([playback worklet](../../src/audio/worklets/playback-processor.js#L71)).
- The debug page begins avatar startup before realtime's connection guard is active, allowing duplicate avatar startup from repeated clicks ([App.tsx:262](../../src/App.tsx#L262)).

## Evidence integrity and persistence

### A10 — Rejected quotes leave an unsupported conclusion unchanged

The quote filter checks normalized interviewee text and drops quotes that fail inclusion. Assessment, confidence, rationale and overall verdict are accepted independently. A stubbed OpenAI response containing only one fabricated quote returned `droppedQuotes:1` and empty evidence while retaining `Supported`, `high`, and overall `Supported`.

Evidence: [quote filter and assessment construction](../../server/validation.ts#L237), [overall verdict](../../server/validation.ts#L267).

Follow-up: flag or downgrade conclusions whose required evidence has been removed and expose the rejection to reviewers. Quote inclusion is useful provenance checking, but does not validate contextual support or the truth/identity of client-submitted transcript content.

### A11 — Relay continuity depends on one process and arrival order

The session Map is capped at 200 and removes the oldest entry without checking for active calls or attached watchers. A local HTTP check confirmed the original session becomes 404 after enough later creations. Process restart loses every session. Multi-instance routing would need shared state or session affinity; an SSE subscriber and state POST otherwise need not reach the same Map.

State publication sends full snapshots without a sequence/version. The server accepts whichever request arrives last; a delayed older request can overwrite newer or ended state. The participant ignores POST errors and final publication is only a `keepalive` attempt. Existing watchers are not explicitly closed when their entry is evicted.

Evidence: [Map/eviction](../../server/interviews.ts#L31), [unversioned replacement](../../server/interviews.ts#L70), [participant publishing](../../frontend/src/routes/interview.$sessionId.tsx#L57).

Follow-up: define durable session ownership, ordered/idempotent writes, final-state acknowledgement and retention/expiry. Explicitly close expired streams and resolve active sessions before eviction. Design shared state/pub-sub before scaling beyond one process.

### A12 — Real research is not consistently represented across Findings and reports

Findings' empty-state gate checks mock-derived findings or completed interviews in the current round. Real mirrored transcript turns have no `questionId`, while the legacy extractor requires one. For real-only research without surviving legacy/mock findings, starting a new round therefore hides historical validation until a current-round interview completes, even though validation itself reads completed interviews across rounds. Mixed demo/real projects may bypass that gate. The separate printable-report route always uses the mock findings generator and ignores model validation.

The local round fixture confirmed the gate has neither derived findings nor a current completion after archiving real evidence. Evidence: [Findings gate](../../frontend/src/routes/projects.$projectId.findings.tsx#L62), [live transcript projection](../../frontend/src/components/live-call.tsx#L86), [extractor requirement](../../frontend/src/lib/mock-service.ts#L476), [report generator](../../frontend/src/routes/projects.$projectId_.report.tsx#L30).

Follow-up: derive visibility and exports from the same analysis/evidence revision across all rounds. Keep a deliberately labeled demo path separate if it remains useful.

### A13 — Ordinary source/plan edits break ID-based provenance

Disconnecting a demo network or deleting a contact removes its Expert record while interview/plan `expertId` references survive. Historical UI and validation payloads then lose participant name/background. Separately, sending an invitation retains `Not Started` status, which leaves its plan unlocked; reapproval recreates interview IDs and discards the local link to the existing backend session.

Evidence: [network removal](../../frontend/src/routes/projects.$projectId.sources.tsx#L63), [contact deletion](../../frontend/src/routes/projects.$projectId.sources.tsx#L373), [participant lookup](../../frontend/src/lib/thesis-validation.ts#L32), [invitation state](../../frontend/src/components/live-call.tsx#L186), [plan lock/reapproval](../../frontend/src/routes/projects.$projectId.plan.tsx#L66).

Follow-up: retain immutable participant metadata on each interview, soft-delete referenced contacts, and model invited/session-created state. Make approval idempotent or explicitly cancel/replace invitations when the plan changes.

### A14 — Request shaping and upstream deadlines are incomplete

The API mostly uses TypeScript assertions plus `Array.isArray`, rather than validating nested request/response schemas. Large/malformed items can reach prompt construction and output mapping. Some next-round prompt construction runs before the handler's `try`, so malformed nested values can reject outside its intended error response. Provider fetches have no application-defined abort/deadline or retry policy. Long waits can retain active startup/analysis operations and amplify concurrent work.

Evidence: [global body parser](../../server/index.ts#L45), [initial-question payload construction](../../server/index.ts#L232), [next-round prompt construction before try](../../server/validation.ts#L338), [provider fetch](../../server/validation.ts#L113), [avatar calls](../../server/avatar.ts#L145).

Follow-up: validate bounded nested schemas before prompt building, keep async handlers fully covered by error handling, and introduce explicit deadlines/cancellation. Treat model JSON as untrusted structured output. Delimit transcript/contact content and verify important decisions rather than relying solely on prompt instructions to resist embedded instructions.

### A17 — localStorage is a single-browser persistence mechanism

The store parses saved data without a runtime schema or migration, then rewrites the entire project array on every update. Writes have no exception handling and no `storage`-event merge/reconciliation. Two dashboard tabs can overwrite each other's snapshots; quota or unavailable storage can fail a write. Changing to the versioned `v2` key deliberately abandons earlier saved projects rather than migrating them.

Evidence: [hydration and writes](../../frontend/src/lib/store.tsx#L19), [mutation functions](../../frontend/src/lib/store.tsx#L61).

Follow-up: define a versioned persistence schema with recovery/export, handle write errors, and add revision-aware cross-tab coordination. A multi-user product needs a server-backed project/evidence store with access control. Removing a browser project should have an explicit relationship to backend-session cleanup.

## Build, verification and operational boundaries

### A15 — Production wiring for the separate Express API is absent

Root build succeeds but emits the Vite client; server TypeScript is `noEmit`, and there is no production API start/package/deployment configuration. Dashboard build succeeds and emits a Cloudflare-module Nitro application, but does not incorporate or route to the Express API. The checked-in proxies are under Vite dev `server.proxy`. Changing `PORT` also leaves both proxies pointing to 3000.

Evidence: [root scripts](../../package.json#L8), [server compiler config](../../tsconfig.server.json#L9), [root proxy](../../vite.config.ts#L10), [dashboard wrapper/proxy](../../frontend/vite.config.ts#L1). Build results are in [verification.md](verification.md).

Follow-up: select the API hosting/runtime, production same-origin routing, HTTPS/media origins, SSE timeout/buffering behavior, durable state, secret provisioning, health/readiness and shutdown ownership. Preview-server behavior should not be assumed to define production routing.

### A16 — Green unit/build jobs do not establish the full integration contract

All 31 root and 13 dashboard tests passed again on the latest snapshot, as did root typecheck and both builds. Full dashboard `tsc` still fails with 54 shared-code diagnostics after build regenerates the participant route. The original audit also observed 56 diagnostics before route generation, including two stale-route diagnostics. CI explicitly ignores the full exit status and filters diagnostics to selected paths. Thus shared audio/realtime/state typing errors can coexist with a green filtered job. The generated route tree remains stale in source and gains the participant route during build.

The unit tests mainly exercise audio conversion, transcript replay, local/mock helpers and route matching. They do not cover the actual session/SSE, call cleanup, active-round transitions, real Findings cache lifecycle, avatar write failures, or Python workers. The new audit reproductions exposed gaps without contacting providers.

There is now a separate manually dispatched [OpenAI workflow](../../.github/workflows/openai-check.yml). It checks credentials/model access, starts Express, and calls `/api/initial-questions` with a fixed fixture. It is not a push/PR gate and does not exercise the browser, Boson, avatar or session relay. This audit checked its LF-based thesis extraction without dispatching it or contacting OpenAI. The fixture supplies three abbreviated hypotheses rather than the thesis's full seven pillars, and success is principally an HTTP/nonempty-question check rather than a research-quality assertion.

Evidence: [CI diagnostic filter](../../.github/workflows/ci.yml#L46), [root tests](../../test), [dashboard tests](../../frontend/src/test), [strict dashboard config](../../frontend/tsconfig.json), [generated route tree](../../frontend/src/routeTree.gen.ts).

Follow-up: establish an authoritative full typecheck with explicit tracked debt, and add focused boundary tests for A03-A13. Keep automated provider smoke tests separately gated by credentials/budget. Restore/commit generated artifacts consistently rather than depending on an undocumented pre-typecheck build.

### A18 — Independent dependency tracks need independent validation

The Python implementations use pinned upstream Git forks for unreleased Boson integrations, with uv locks but no CI jobs. Both import a shared JSON fixture outside their own directory, so deploying only a Python folder is insufficient. The browser avatar SDK is a versioned CDN script outside the JavaScript lockfiles. Dashboard CI uses a frozen Bun lock, while setup docs recommend npm and do not pin a Bun version.

Evidence: [Pipecat fork](../../pipecat/pyproject.toml#L15), [LiveKit fork](../../livekit/pyproject.toml#L16), [shared Python fixture](../../pipecat/tools.py#L21), [avatar CDN](../../src/avatar/AvatarLink.ts#L18), [Bun CI](../../.github/workflows/ci.yml#L32), [dashboard setup](../../frontend/README.md#L17).

Follow-up: run a compatibility/build gate for each supported track, package shared resources deliberately, pin/document the package-manager workflow, and decide whether the browser SDK should be bundled. Preserve the existing Rolldown override until its compatibility is explicitly verified.

### A19 — New evidence can leave validation stale without a follow-up request

When evidence changes during an in-flight request, `useThesisValidation` records the new key as tried and invokes `run`. That call exits because `running.current` is already true. The older request then saves its result, but the new key has been marked tried, so the effect never launches the required follow-up. Findings treats stale data as working and disables Re-run, leaving the progress state stuck until a remount or another key change.

This was reproduced with the real hook, a deferred first response, and a second interview changing to completed before that response resolved. The final hook state had the old cached key, `stale:true`, `loading:false`, and only one fetch. The new background Findings poller makes this a normal completion scenario rather than requiring a manual edit during validation.

Evidence: [running guard](../../frontend/src/lib/thesis-validation.ts#L102), [result write](../../frontend/src/lib/thesis-validation.ts#L108), [tried-key gate](../../frontend/src/lib/thesis-validation.ts#L119), [Findings polling](../../frontend/src/routes/projects.$projectId.findings.tsx#L54), [working state](../../frontend/src/routes/projects.$projectId.findings.tsx#L258), [disabled rerun](../../frontend/src/routes/projects.$projectId.findings.tsx#L295).

Follow-up: queue the newest pending input revision and run it when the current request finishes. Mark a revision as attempted only when its request actually starts, reject stale responses, and distinguish waiting/queued work from an active request in the UI.

## Other bounded observations

- Root and Python probes are diagnostics, not strong acceptance gates: typed replies/tool semantics are not asserted, and root reply waits can time out without failing the process ([root probe](../../tools/probe.ts#L354), [Pipecat probe](../../pipecat/probe.py#L64), [LiveKit probe](../../livekit/probe.py#L66)).
- The debug UI retains raw audio events in an unbounded React log before export redaction; extended sessions can consume increasing memory ([App.tsx](../../src/App.tsx#L226)).
- SSR diagnostic capture is process-global, so concurrent requests can overwrite the last captured error. The returned error page does not disclose that captured error ([error-capture.ts](../../frontend/src/lib/error-capture.ts#L55), [server wrapper](../../frontend/src/server.ts#L23)).
- Root README and `frontend/AGENTS.md` retain broad “frontend-only/simulated/no persistence” language that no longer describes the live API integrations and browser persistence. The new architecture reference records current behavior without editing those active files.

## Suggested follow-up order

1. Resolve live synchronization and evidence correctness: A03-A05, A10, A12-A13, A19.
2. Centralize voice lifecycle ownership and version question orchestration: A06-A09.
3. Before untrusted/shared deployment, implement A01-A02 plus durable ordered sessions and production wiring: A11, A14-A15, A17.
4. Make the full integration contract observable and testable: A16, A18, focused media/probe follow-up.

Acceptance checks should reproduce the stated triggers: unchanged snapshots must not resubscribe; full-payload edits must invalidate analysis; archived active calls must either be resolved or keep updating; stop must remain final after delayed startup; rejected evidence must not silently retain an unsupported conclusion.
