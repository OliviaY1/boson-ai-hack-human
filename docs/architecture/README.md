# Diligence Live architecture reference

Audited and rechecked on **2026-10-24**, against application commit [`f212a7046a2a4b66b4967c57d0528c4016737bf2`](https://github.com/OliviaY1/boson-ai-hack-human/tree/f212a7046a2a4b66b4967c57d0528c4016737bf2). Commit subject: “Add a manual GitHub Actions check of the Research Plan's GPT-6 call”. The audit describes that snapshot; concurrent and later development can change these conclusions.

Diligence Live combines a browser-persisted research dashboard, a shared browser voice engine, and a small Express API for provider access and interview-state relay. The repository also contains the original tutorial/debug app and two independent Python tutorial implementations.

The recheck reviewed the five application commits since the original `9a82ca0` snapshot. They add background session polling, all selected contacts in generic plans, Oakville defaults, clearer backend errors, safer model discovery and a manual OpenAI smoke workflow. All 18 original findings remain open, with some reliability/diagnostic improvements; a further validation-in-flight race is recorded as A19. See [the verification record](verification.md) for rerun results.

## Read this documentation

| Document | Purpose |
| --- | --- |
| [Tech stack](tech-stack.md) | Dependencies, source map, endpoints, configuration and ownership of stored data |
| [Architecture](architecture.md) | System boundaries, runtime topology and logical domain model |
| [Data flows](data-flows.md) | Interview sequence, audio/adaptation pipeline and iterative research flow |
| [Audit findings](audit.md) | Prioritized defects and risks, evidence, practical impact and suggested follow-up |
| [Verification](verification.md) | Checks actually performed, results, limitations and diagram regeneration |

## Reusable diagrams

Open [the interactive chart gallery](gallery.html) to browse all eight diagrams with zoom controls and links to the SVG exports and Mermaid sources. After cloning the repository, open `docs/architecture/gallery.html` directly in a browser. It uses relative files and requires no server, build step or external dependencies. GitHub's file view displays HTML source; download/clone the folder to use the gallery locally.

The Markdown pages include Mermaid code blocks that GitHub can render. Each diagram also has an editable standalone `.mmd` source and an SVG export for slides, documents and other tools.

| Diagram | Editable source | Export |
| --- | --- | --- |
| Technology stack | [01-tech-stack.mmd](diagrams/01-tech-stack.mmd) | [SVG](diagrams/01-tech-stack.svg) |
| System architecture | [02-system-architecture.mmd](diagrams/02-system-architecture.mmd) | [SVG](diagrams/02-system-architecture.svg) |
| Interview sequence | [03-interview-sequence.mmd](diagrams/03-interview-sequence.mmd) | [SVG](diagrams/03-interview-sequence.svg) |
| Audio and question adaptation | [04-audio-and-adaptation.mmd](diagrams/04-audio-and-adaptation.mmd) | [SVG](diagrams/04-audio-and-adaptation.svg) |
| Research data flow | [05-research-data-flow.mmd](diagrams/05-research-data-flow.mmd) | [SVG](diagrams/05-research-data-flow.svg) |
| Logical domain model | [06-domain-model.mmd](diagrams/06-domain-model.mmd) | [SVG](diagrams/06-domain-model.svg) |
| Runtime topology and Python alternatives | [07-runtime-topology.mmd](diagrams/07-runtime-topology.mmd) | [SVG](diagrams/07-runtime-topology.svg) |
| Data ownership and external processing | [08-data-ownership.mmd](diagrams/08-data-ownership.mmd) | [SVG](diagrams/08-data-ownership.svg) |

## Placement and maintenance

Everything added for this audit is under `docs/architecture/`. The existing numbered tutorials remain in `docs/part-*.md`. No application source, package manifest, lockfile, configuration, root README or existing tutorial needs to change to use these references. This directory is outside the checked-in application/test entry points.

The work was prepared and verified in a managed worktree. After the requested fast-forward pull, the documentation commit was integrated into the main checkout. Changes authored for this audit remain confined to this directory. No provider credentials were copied into the verification worktree, and no live model, microphone or avatar sessions were used for the audit.

For an update:

1. Record the new audited SHA and date here and in [verification.md](verification.md).
2. Trace changed behavior from source; keep existing implementation and proposed improvements clearly identified.
3. Edit the affected `.mmd` source, replace the matching Mermaid block in its Markdown page, and regenerate its SVG.
4. Check source links and render each changed diagram. Record application checks separately from diagram checks.

Versions in this reference come from committed manifests and lockfiles. Provider model IDs describe configured requests, rather than a claim that those models were available or exercised during this audit. Findings link to local source paths with line fragments; the pinned commit above is the stable reference if line numbers move.
