# Architecture

## 1. The hard constraint: "normal usage, not the API"

You want the tutor to run on a Claude subscription, not metered API keys. What I verified
(October 2026):

- `claude -p`, the Claude Agent SDK, and ACP tools currently **draw from the subscription's
  usage limits**. A planned switch to a separate "Agent SDK credit" pool, announced for
  15 June 2026, is **paused**
  ([Claude support](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan),
  [Zed blog](https://zed.dev/blog/anthropic-subscription-changes)). So `claude -p` is *not*
  API-only, as you suspected. But it is a single-shot, non-interactive mode and fits a chat
  tutor poorly.
- The official ACP adapter for Claude (`@agentclientprotocol/claude-agent-acp`) offers a
  **"Claude Subscription" terminal auth method**: the user runs `claude auth login`
  themselves, and turns draw on their plan.
- **Distribution caveat:** Anthropic does not allow third-party developers to *offer claude.ai
  login* or route subscription credentials on behalf of their users without approval
  ([report](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/),
  [VentureBeat](https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch)).
  Anthropic also says that if you build *a business* on the Agent SDK, you should use API keys.
  The policy has changed several times this year.

**Design consequence:** the app must **never touch credentials**. It launches the agent the
user has *already installed and logged into* (Claude Code, Gemini CLI, Codex, OpenCode, Goose,
a local model…), the same way Zed and JetBrains do. The app is an *editor that hosts an agent*,
not a Claude client. Before public distribution we should still check the current terms or ask
Anthropic directly (see `decisions.md`, Q1).

## 2. Integration: three layers, two open protocols

```
┌──────────────────────────── App (UI: web tech) ─────────────────────────────┐
│  Workspace │ Lesson viewer │ Ask panel │ Mastery map │ Profile │ Editor      │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ local RPC (WebSocket, authenticated)
┌───────────────────────────────▼─────────────────────────────────────────────┐
│                         CORE  (local process)                               │
│  Store (files, schemas, migrations, atomic writes)                          │
│  Learner model engine (knowledge tracing, review scheduler) ── deterministic│
│  Curriculum graph · Lesson compiler/validator · Test runner                 │
│  Policy gate (what the agent may read / write / see)                        │
│                                                                             │
│   ┌── ACP client ──────────────┐        ┌── MCP server ("teacher tools") ─┐ │
│   │ spawns user's agent        │        │ get_context, propose_update,    │ │
│   │ streams turns to the UI    │◄──────►│ write_lesson, record_evidence,  │ │
│   │ answers permission requests│        │ run_checkpoint, cite_research…  │ │
│   └─────────────┬──────────────┘        └───────────────▲─────────────────┘ │
└─────────────────┼───────────────────────────────────────┼───────────────────┘
                  │ stdio (JSON-RPC)                       │ stdio / local
         ┌────────▼─────────────────────────────────────────┴───────┐
         │  User's own agent: claude-agent-acp → Claude Code (Opus) │
         │  or any ACP agent; logged in by the user, not the app    │
         └──────────────────────────────────────────────────────────┘
```

### Layer A: ACP (Agent Client Protocol), for *driving* the agent
The app is an ACP **client**, like Zed. It starts the agent as a subprocess, opens sessions,
sends prompts (the learner's question plus a selection reference), streams replies into the Ask
panel, and, most importantly, **answers the agent's permission and file-system requests**.
ACP lets the client provide `fs/read_text_file` and `fs/write_text_file` and asks the client to
approve tool calls. That gives us a **real enforcement point** for P1: the core can refuse
writes to the learner's solution files whatever the model decides.

*To verify in a spike:* exactly which of Claude Code's built-in tools go through ACP
permission requests when run under `claude-agent-acp`, and which run directly. If any bypass
the gate, add the layer B/C defences below. We don't rely on any single one.

### Layer B: MCP server, for the *tools* the agent uses to teach
The core exposes a narrow, schema-checked tool surface instead of raw file access to profile
data. Draft tool list:

| Tool | Purpose | Notes |
|---|---|---|
| `get_teaching_context(scope)` | Learner summary, current lesson, active misconceptions, preferences, the rules | **Redacted view**, built by code, never raw files |
| `get_lesson(id)` / `get_section(id, anchor)` | Read lesson content | |
| `read_workspace_file(path)` | Read the learner's code (read-only) | Scoped to the project's workspace |
| `propose_learner_update(patch, evidence)` | Suggest a change to the learner model | Validated, merged by code, logged, reversible |
| `record_insight(text, scope, evidence)` / `support_insight(id, evidence)` / `contradict_insight(id, evidence)` | Hypotheses about how this learner learns | Trust computed by code, never set by the agent (data §3.6) |
| `record_evidence(kc, kind, outcome, note)` | Log an observation (drill answer, explanation quality, hint used) | Feeds the deterministic tracer |
| `draft_lesson(lesson)` / `revise_lesson(id, patch)` | Write lesson content | Compiled and validated; rejected if it violates the policy (e.g. a solution leak check on stubs) |
| `stage_tests(lesson, files)` | Add checkpoint tests | Tests go to a staging dir, not into the learner's code |
| `run_checkpoint(lesson, step)` | Run the staged tests, get pass counts | Run by core, results are facts. *Built differently:* only the learner starts a run (from the task); the tutor reads the results in its context, so the agent never executes anything |
| `update_skill_map` / `get_skill_map` | Describe the profile's skills, groups, links and suggestions | Validated (acyclic prerequisites); never holds a level |
| `set_curriculum` / `save_assessment` | The project's goals and rolling plan; what the interview found | Whole documents, reviewed or auto-applied, undoable |
| `give_hint(task, level)` | Records which hint-ladder level was used | The agent writes the hint; core enforces the level order |
| `search_research(topic)` | Query the bundled, read-only research base | Lets the agent cite *why* it teaches a certain way |
| `search_resources(topic)` | Curated external links stored per project | |

Any MCP-capable agent can use these, which covers P9.

### Layer C: packaged as a Claude Code plugin, for terminal users
The same MCP server plus skills (the teaching rules, the lesson-authoring guide) plus hooks
(e.g. a `PreToolUse` hook that blocks `Edit`/`Write` on workspace paths) can ship as a Claude
Code plugin. Someone could then use the whole system from the terminal with no GUI. It also
gives a second, independent enforcement layer when Claude Code runs inside the app.

### Keeping solutions out of sight (the threat model)
The goal is **not** to stop a determined user: anyone can open a browser and ask any chatbot.
The goal is that a learner who *wants* to learn is **never shown the answer by accident**,
whatever the model does. So the layers below protect against the model's mistakes, not
against the user. Bypassing them on purpose is possible, and that's fine.

### Layers
1. ACP: the client refuses `fs/write_text_file` and edit permission requests for workspace paths.
2. Agent config generated by the app: Claude Code `permissions.deny` for `Edit(workspace/**)`,
   `Write(workspace/**)`, and shell commands that write there. The agent's cwd is the *lesson*
   dir, not the workspace.
3. Plugin hook: `PreToolUse` blocks the same.
4. Detection: core snapshots the workspace (an internal git repo) on each agent turn and
   attributes every change. A write the learner didn't make is flagged and can be reverted.
5. Content policy: chat replies run through a cheap deterministic check (e.g. a large code
   block that closely matches the open task's expected shape triggers a "this looks like a
   solution" reveal gate in the UI). This is heuristic, so it is the last layer, not the first.

### The three places the core writes outside the profile
- **Checkpoint runs** execute the learner's test command in the workspace: split into words,
  never through a shell, with a timeout and an output cap, in its own process group. A task's
  suite is only substituted where the learner wrote `{suite}`, and only if it is a plain test
  name. A project whose test command was last changed by the agent is refused.
- **The embedded editor** saves a file only on the learner's explicit save, inside the workspace
  (symlink escapes refused), and only over the version the learner opened: a change made
  meanwhile in another editor is reported, never overwritten silently. The agent has no route to
  either.
- **The tutor's files**, only where the learner allowed it (project settings: tests in a folder of
  their own, tools such as a viewer in named folders, edits to the learner's files only if
  allowed and then always reviewed). The agent's own write tools stay disabled; it writes through
  one MCP tool, `write_file`, which checks the permission, refuses code that implements an open
  task (the solution gate, on the file), and records each write as a change: reviewed or applied
  per the learner's setting, undoable, and checked against the disk first, so a change the
  learner made meanwhile is never overwritten. With "measure" allowed, the tutor can run the
  learner's test command and the commands they listed (same runner: no shell, bounded).

## 3. Components (core)

| Component | Responsibility | Deterministic? |
|---|---|---|
| **Store** | Profile and project directories, JSON Schema validation, versioned migrations, atomic write (temp + fsync + rename), append-only event log | Yes |
| **Learner engine** | Folds events into mastery per knowledge component (uncertainty-weighted Elo, see pedagogy-model §2), FSRS review scheduling, calibration score, hint-dependence score | Yes |
| **Curriculum graph** | Knowledge components (KCs) and prerequisite edges per project, links to shared KCs across projects | Yes (LLM proposes nodes) |
| **Lesson compiler** | Parses lesson source → validated AST → renderable bundle; rejects bad blocks | Yes |
| **Component renderer** | Renders catalog components; the agent never supplies markup or code (component-catalog.md) | Yes |
| **Expression evaluator** | Pure, budgeted interpreter for `explorable` models | Yes |
| **Source ingestor** | Local text extraction + anchors for imported PDFs/notes | Yes |
| **Test runner** | Runs staged checkpoint suites through project-defined commands (`ctest`, `cargo test`, `pytest`…), parses results | Yes |
| **Policy gate** | Path rules, redaction, permission answers, rate limits on learner-model writes | Yes |
| **Agent host** | ACP client, session lifecycle, prompt assembly from files | Yes (the agent itself isn't) |
| **Context builder** | Assembles the per-turn context: rules + redacted learner summary + lesson anchor + selection | Yes |

## 4. Stack (decided, see decisions.md D8)

You left the choice to me, so the deciding criterion was "gets the job done best": the
fewest moving parts, the strongest testing story, and code that open-source contributors (and
weaker coding models) can work on.

- **Language:** TypeScript end to end, `strict`. The ACP SDK, MCP SDK, and `claude-agent-acp`
  are all TypeScript, so there is **one language and one runtime** across core, UI, and
  protocol code. Runtime: Node (26.x installed).
- **Core:** a standalone Node process (`<app> serve`) that runs **headless**. The desktop shell,
  and any future clients (web, mobile) talk to it, so the shell can be swapped later without
  touching the core.
- **UI: React** (+ React Aria for accessible primitives). Chosen over Svelte because of
  ecosystem depth (Monaco integration, Testing Library, accessibility libraries), because it
  is the most familiar choice for open-source contributors, and because you know it if you
  ever want to change things yourself. Bundled with Vite.
- **Desktop shell: Electron.** Chosen over Tauri because the core is Node: Electron ships Node
  natively, while Tauri would need a separately bundled Node sidecar (two runtimes, two
  toolchains, Rust in CI). Other reasons: `node-pty` for spawning agent CLIs is mature on
  Electron, Monaco *is* VS Code's editor (VS Code is Electron), and **Playwright can drive
  Electron apps directly**, which matters for the "everything tested" requirement. Cost:
  ~100+ MB installs, which is acceptable for a dev tool. Because the core is headless, moving
  to Tauri later stays possible.
- **Mobile (post-MVP):** the same React UI can later be served by the core as a PWA (§7).
- **Editor:** Monaco, plus "open in external editor"
  with the core watching the workspace.
- **Rendering:** KaTeX for maths; SVG for `diagram2d`, `plot`, `graph`, `memory-layout`;
  three.js for `diagram3d`. All renderers are app code behind the component catalog.
- **Validation:** Zod schemas generating JSON Schema (one source of truth for MCP tool schemas,
  file schemas, and the catalog).
- **Tests:** Vitest, fast-check, Playwright (web + Electron), axe-core, and a scripted fake
  ACP agent (see `quality.md`).
- **License:** open source, choice pending (decisions Q12).

## 5. The agent turn, step by step

1. The learner selects a passage in lesson section 03 and asks "why the right side?".
2. The UI sends `{profileId, projectId, lessonId, anchor: "s03:p4", selection, question}` to core.
3. The context builder assembles: teaching rules (read-only) + redacted learner summary +
   lesson section + nearby task state + current hint level + the question.
4. The agent host sends this to the ACP session and streams the reply to the Ask panel.
5. While running, the agent may call MCP tools: e.g. `read_workspace_file` to see the
   learner's `Integrate.cpp`, `record_evidence` ("learner confuses frames of ω"), or
   `revise_lesson` to add a clarifying note under that paragraph.
6. Core validates every write, logs it to the event log, and updates derived state.
7. The UI shows any lesson revision as a diff the learner can accept or roll back.

## 6. Sessions and memory

The agent's conversation memory is always **disposable**: everything that matters is in
files. How long a session lives is **the learner's choice** (Settings → Agent):

| Mode | A session lives for | Best for |
|---|---|---|
| **Per interaction** | One question or one authoring task, rebuilt from files each time | Small or local models (short context), lowest cost, the most reproducible |
| **Per lesson** (default) | One lesson, from authoring through all its questions | Strong models: keeps the thread of a lesson without growing forever |
| **Permanent** | Until the learner resets it; compacted by the agent when it gets long | Very strong, long-context models, or learners who like an ongoing conversation |

The settings screen explains the trade-off in one line per mode and recommends one based on
the detected agent/model. Session summaries are stored as files the learner can read and edit.

## 7. Platforms and offline

- **MVP: desktop** (Linux, macOS, Windows), **offline-first**. The app itself never needs the
  internet. The only network traffic is what the user's *agent* does (e.g. Claude Code
  talking to Anthropic) and what the user's own toolchain does (e.g. a compiler fetching
  dependencies). With a local model, the whole system runs offline.
  - Every app asset (fonts, KaTeX, three.js, renderers) ships with the app. No CDNs.
- **Mobile: after the MVP.** The architecture keeps the door open: the core is headless and
  the UI is a web app, so a phone client of the desktop core, or a reduced standalone mode
  (review, reading), can be added later without redesign.
- **Cross-platform discipline from day one:** CI on all three desktop OSes, no OS-specific
  paths or shell assumptions in the core, and a responsive UI even on desktop.

## 8. Spike findings (2026-10-05, real Claude Code 2.1 via claude-agent-acp 0.86)

Verified against the real agent on a subscription login (`scripts/spike-*.ts`):

1. **No write tools at all.** `session/new` `_meta.claudeCode.options` accepts an explicit
   `tools` list. We pass `['Read', 'Grep', 'Glob']` plus a `disallowedTools` deny-list as a
   second barrier. Asked to "implement it and try every tool", the model found no way to
   write, and the workspace stayed untouched.
2. **Account connectors leak in by default.** Even with `settingSources: []`, the user's
   claude.ai connectors (mail, drive…) were visible to the agent. The permission policy denied
   them, but `strictMcpConfig: true` now hides them entirely. Visible tools: Glob, Grep, Read
   and the app's own MCP tools only.
3. **The chat can still leak a solution.** Told to "follow literally", a bare test agent wrote
   the solution into its chat reply. With the app's constitution as system prompt, it taught
   instead. The content-level guard (a UI reveal gate for code-shaped answers) is still on the
   roadmap; the file-level guarantees above hold regardless.
4. **Teaching tools over HTTP MCP work.** The adapter supports `mcpCapabilities.http`, so the
   core hosts MCP itself (`TeacherHttpServer`, 127.0.0.1, per-session bearer token, DNS-rebinding
   and Origin checks). No proxy process, and the core stays the only writer.
5. **ACP update ordering.** The SDK resolves the prompt response synchronously but dispatches
   `session/update` notifications through an async handler chain, so the last chunks can
   arrive after the response. The host yields one macrotask before emitting `stop`
   (regression-tested with a real subprocess).
6. **Lesson authoring works end to end.** Asked for a short lesson, Claude read the catalog,
   drafted it, got rejected by the validator, fixed the two reported field errors, then acted
   on a composition warning with `revise_lesson` and recorded the instruction. The lesson
   renders with a working 3D explorable.
7. **Electron specifics.** Spawning the adapter with `process.execPath` inside Electron needs
   `ELECTRON_RUN_AS_NODE=1`. Chromium's `--ozone-platform=headless` segfaults on this
   machine's NVIDIA stack, so desktop smoke tests drive a hidden window instead.
