# Aporia (working name)

> A local-first learning workbench where an LLM teaches and the learner does the work.

**Status:** working prototype. You can create a profile and a project, have your tutor (Claude
Code on your own login) interview you and write interactive lessons, answer drills, play with
3D explorables, ask about any selected passage, and undo anything the tutor changed. See
[`docs/roadmap.md`](docs/roadmap.md) for what comes next.

The product name lives in exactly one file: [`packages/brand/brand.json`](packages/brand/brand.json).

## The idea

You learn by building something real, or by studying sources you bring in. An agent works out
what you already know, then writes lessons made of pretests, explorable figures, drills,
build steps with checkpoints, and explanations. **You write the code.** The agent explains,
hints in increasing steps, adjusts the lesson, and records what it observes. Deterministic
code turns those observations into an evidence-based model of how *you* learn.

1. **The learner does the thinking.** The agent gets no write tools. Every file write is refused
   by the app, and lessons have no "solution" component.
2. **State lives in local files the app owns**, in an append-only journal. Every change is
   undoable, and any model can be swapped in without losing anything.
3. **It runs on the agent you already use**, through ACP and MCP, with your own login. The app
   never touches credentials.

## Running it

Requires Node ≥ 24 (developed on 26) and, for the tutor, Claude Code logged in (`claude auth login`).

```sh
npm install
npm run desktop       # the Electron app
npm run serve         # headless: prints a URL to open in any browser
npm run demo          # UI with a scripted tutor and a sample lesson (no agent, no login)
```

Data lives in `~/.local/share/aporia` (Linux), `~/Library/Application Support/Aporia` (macOS)
or `%APPDATA%\Aporia` (Windows). Override it with `APORIA_DATA_DIR`.

## Development

```sh
npm run check         # strict typecheck + all tests + coverage thresholds (run before committing)
npm test              # tests only
npm run smoke:desktop # launches the real Electron app (hidden window) and drives it
node scripts/spike-teacher.ts   # real Claude ↔ app tools round trip (uses your subscription)
node scripts/spike-lesson.ts    # real Claude authors a lesson end to end (a few minutes)
```

| Package | What |
|---|---|
| `brand` | The product name and everything derived from it |
| `core` | Safe paths, atomic writes, profiles, append-only journal, undoable change records, learner engine (Elo ratings, mastery states, FSRS, insight trust, difficulty band) |
| `catalog` | The lesson component catalog: schemas, validator (composition rules, stub check), and a pure, budgeted expression language for explorables |
| `agent-host` | ACP client: launches the user's agent, enforces the permission and file policy, Claude Code specifics |
| `teacher-mcp` | The teaching tools the agent uses (MCP over local HTTP) and the agent-facing rules |
| `server` | The app service and its WebSocket RPC for the UI; session modes; history and undo |
| `ui` | React UI: lesson renderers (maths, 2D/3D diagrams, plots, explorables, drills…), ask drawer, history, open learner model |
| `desktop` | Electron shell (sandboxed renderer, token over IPC) |

Coverage gates: 100% functions, ≥ 98% lines and statements, ≥ 95% branches, across all
non-entry-point code. Entry points are covered by smoke tests and spikes.

## Documents

| Doc | What it covers |
|---|---|
| [vision-and-principles](docs/vision-and-principles.md) | Goals, non-goals, the rules everything else must follow |
| [architecture](docs/architecture.md) | Agent integration (ACP + MCP), components, stack, **spike findings (§8)** |
| [data-and-privacy](docs/data-and-privacy.md) | File layout, profiles, change records and undo, learner model, insights, privacy |
| [learning-science](docs/learning-science.md) | The evidence base: 52 findings, graded A–D, with links |
| [pedagogy-model](docs/pedagogy-model.md) | The system derived from the evidence: learner model, policies, parameters |
| [component-catalog](docs/component-catalog.md) | Everything the agent can display: components and the interaction toolkit |
| [teaching-engine](docs/teaching-engine.md) | Flows: goal capture, interview, curriculum, lesson loop, source import |
| [ux](docs/ux.md) | Screens, workspace, "ask about this", history/undo, motivation |
| [quality](docs/quality.md) | Testing strategy, including evaluating the agent |
| [roadmap](docs/roadmap.md) | **The plan**: phases, what each contains, and the test that says it's done |
| [decisions](docs/decisions.md) | Decision log and implementation status |
| [names](docs/names.md) | Name candidates |

## License

[AGPL-3.0-only](LICENSE).
