# Verification record

Source snapshot: **`9a82ca05d1b15d89209fe0dfd87f0e7d3995c88f`**, audited **2026-10-24**. Work was performed in a managed worktree separate from the active checkout. The snapshot was pinned after fetching GitHub `main`; later pushes were deliberately excluded.

## Application checks actually executed

| Check | Result |
| --- | --- |
| Root dependencies | `npm ci --ignore-scripts --no-audit --no-fund`, using committed npm lock: installed |
| Root unit suite | **31 passed**, 3 files; Vitest 2.1.9 |
| Root TypeScript check | **Passed**, `tsc -b --noEmit` |
| Root production build | **Passed**, `tsc -b && vite build`; Vite client artifacts generated |
| Dashboard dependencies | `bun install --frozen-lockfile --ignore-scripts`: installed using committed Bun lock |
| Dashboard unit suite | **13 passed**, 3 files; Vitest 4.1.11 |
| Dashboard production build | **Passed**, `vite build`; client, SSR and Cloudflare-module Nitro artifacts generated |
| Full dashboard TypeScript before build | **Failed**, exit 2: 56 diagnostics, including 2 for the stale participant route definition |
| Full dashboard TypeScript after build/route generation | **Failed**, exit 2: 54 diagnostics in shared root code |
| Local audit HTTP/state reproductions | **Passed** assertions for the five groups below |
| Local SSE-hook reproduction | **Passed**, 1 temporary test using the real `useLiveCall` hook and mocked EventSource |

The 54 post-build diagnostics are distributed across `src/state/transcriptStore.ts` (27), `src/realtime/RealtimeClient.ts` (14), `src/audio/resample.ts` (6), `src/audio/capture.ts` (3), `src/tools/handlers.ts` (3), and `src/audio/playback.ts` (1), relative to repository root. They reflect stricter dashboard compiler settings. CI deliberately filters to selected integration paths rather than treating this complete result as authoritative; see A16.

Local environment: Windows, Node **26.5.0**, npm **12.0.1**, temporary Bun **1.4.4**. Root CI selects Node 22. The host's PowerShell `npm` shim referenced a nonexistent nested npm path; the existing npm CLI was invoked directly with Node instead. No machine installation was repaired or changed. Dependencies were installed only in the isolated worktree; diagram/Bun tooling was installed in a temporary directory outside the repository.

The frontend build regenerated `frontend/src/routeTree.gen.ts`, adding the existing participant route. That generated change was inspected and restored to the pinned version after checking it, so it is not part of this documentation change. Build output and node_modules are ignored. No tracked application, configuration or lockfile changes remain.

## Credential-free reproductions

A temporary TypeScript harness imported the audited modules and, where needed, started an ephemeral HTTP server bound to `127.0.0.1`. It used synthetic project/session content. For the validation route, every external fetch was blocked except an in-process stubbed OpenAI response; the API key/model strings were placeholders. No real API request was made.

1. **Cache collisions, A04:** equal-length thesis changes after character 40 and equal-length transcript replacements produced the same `validationInputKey` despite different submitted content.
2. **Round transition and Findings gate, A05/A12:** archiving a fixture with one completed and one active interview left the active interview outside the current-only updater. The real-only historical fixture had no derived legacy findings and no current completed interview after transition.
3. **Session capability, A02:** the session ID alone retrieved full config, overwrote state, requested termination and subscribed to the initial SSE snapshot, without authentication headers/cookies.
4. **Capacity eviction, A11:** creating enough later sessions made the oldest record return 404, irrespective of an explicit terminal-state check.
5. **Evidence filtering, A10:** a stubbed response with a fabricated quote returned `droppedQuotes:1` and empty evidence, while `Supported`/`high` and the overall `Supported` verdict survived.

A separate temporary Vitest harness rendered the real dashboard hook with an equivalent inline parent updater. A mocked EventSource supplied the same initial ended snapshot for each connection. It asserted at least four EventSource constructions and repeated mirror writes/closures without new server state, confirming A03's dependency feedback loop. This checks React hook behavior, not production proxy/network behavior.

These harnesses and their synthetic data were kept outside the repository. They are audit evidence rather than new application tests. Their triggers and expected future behavior are described in [audit.md](audit.md).

## Diagram and documentation checks

- All eight standalone Mermaid sources were parsed and rendered to SVG using **Mermaid CLI 12.0.0 / Mermaid 12.2.0**, with the local headless Chrome executable.
- Each `.mmd` source has a matching Mermaid block in its Markdown page and a parseable SVG export.
- Local source/document/export links and line fragments were checked for existing targets and valid line bounds.
- SVGs were rasterized for visual inspection, including the stack, system, sequence, audio, research, domain, runtime and ownership views.
- Independent read-only reviews checked the dashboard state model and voice diagrams. Startup ordering and the placement of EventSource were corrected from that review.
- Final Git scope checks verify that additions are confined to `docs/architecture/` and that the active checkout's tracked files remain unchanged.

SVG exports use a white background and [the committed rendering configuration](mermaid.config.json). The detailed sequence/domain diagrams are intentionally larger than the overview diagrams; use the SVG at a readable zoom or adapt the `.mmd` source for a presentation.

## Reuse and regeneration

From the repository root, with Node/npm and a compatible browser available, one diagram can be regenerated without adding an application dependency:

```powershell
npx --yes --package '@mermaid-js/mermaid-cli@12.0.0' mmdc `
  -i docs/architecture/diagrams/02-system-architecture.mmd `
  -o docs/architecture/diagrams/02-system-architecture.svg `
  -c docs/architecture/mermaid.config.json -b white
```

To regenerate all exports:

```powershell
Get-ChildItem -LiteralPath docs/architecture/diagrams -Filter '*.mmd' |
  ForEach-Object {
    npx --yes --package '@mermaid-js/mermaid-cli@12.0.0' mmdc `
      -i $_.FullName `
      -o ([System.IO.Path]::ChangeExtension($_.FullName, '.svg')) `
      -c docs/architecture/mermaid.config.json -b white
    if ($LASTEXITCODE -ne 0) { throw ('Diagram failed: ' + $_.Name) }
  }
```

CLI version pinning alone does not freeze its transitive Mermaid dependency; the exact renderer observed in this audit is recorded above. If supplying an installed browser rather than the CLI-managed browser, use a Puppeteer config file outside the repository and pass it with `-p`. No host-specific browser path belongs in these reusable docs. After editing a source, also replace its fenced Mermaid block in the linked Markdown page.

## Limits of the evidence

The audit did not exercise real Boson/OpenAI/Anthropic/LiveKit credentials, microphone permissions/hardware, avatar playback, actual phone calls, provider model availability, production deployment, multi-instance scaling, sustained load, browser compatibility matrices or Python runtime installs. No live user research, secret values or provider billing operations were used. External provider retention/availability claims are not established by this repository audit.

The checked-in Python tracks, their locks and probes were inspected statically; neither Python track was launched. Runtime timing risks are labeled accordingly in the audit. Passing the existing suites and builds does not resolve the findings or establish production readiness.
