# Data, profiles, and privacy

## 1. Ownership classes

Every file belongs to exactly one class. The class decides who may write it.

| Class | Examples | Learner writes | Agent writes | Core writes |
|---|---|---|---|---|
| **System (read-only)** | Teaching rules, research base, lesson schema, built-in skills | – | – | only on app update |
| **Learner model** | Mastery, misconceptions, preferences, notes | yes (edit in UI) | *proposes* via MCP | yes (merge, derive) |
| **Curriculum & lessons** | Project graph, lessons, staged tests, imported sources | yes | yes (validated) | yes |
| **Workspace** | The learner's own code | yes | **never** | snapshots only |
| **Event log** | Append-only history | – | via tools | appends only |

## 2. Directory layout

```
<data-root>/                            # e.g. ~/.local/share/<app>/ (XDG), %APPDATA% on Windows
  system/                               # shipped with the app, read-only, versioned
    rules/constitution.md               # P1–P9 written for the agent
    rules/hint-ladder.md
    rules/lesson-authoring.md
    research/*.md                       # the research base, one finding per file, with citations
    schemas/*.schema.json
  profiles/
    <profile-id>/                       # one person; optionally encrypted (see §5)
      profile.json                      # name, created, schema version, settings
      learner/
        model.json                      # DERIVED: mastery per KC, calibration, etc. (rebuilt from events)
        preferences.json                # stated and observed, kept separate
        misconceptions.json             # active, resolved, with evidence links
        notes.md                        # free-form; learner and agent (via proposals)
        skills-global.json              # KCs shared across projects (e.g. "quaternions")
      events/
        2026-10.jsonl                   # append-only; SOURCE OF TRUTH for derived state
      projects/
        <project-id>/
          project.json                  # goal, workspace path, test command, status
          interview/transcript.md       # onboarding interview (summarised)
          interview/assessment.json
          curriculum.json               # KC graph + lesson plan (versioned)
          sources/<source-id>/        # imported papers/PDFs/notes + extracted text with anchors
          lessons/
            09-four-numbers/
              lesson.md                 # lesson source (see teaching-engine.md §4)
              tests/                    # staged checkpoint suites
              ladder.json               # expected pass counts per step
              revisions/                # every agent edit, as a diff
          sessions/                     # chat summaries per sitting (readable, editable)
      .snapshots/                       # internal git of workspaces for change attribution
```

Workspaces (the learner's actual code, e.g. `~/dev/heavy-metal-physics`) stay where the
learner keeps them. The project only *points* at them, so the app never moves your repos.

## 3. The learner model

Built from research on student modelling (knowledge tracing, open learner models). **Derived
state is rebuilt from the event log**, so a bad derived file can always be regenerated and the
model is auditable ("why does it think I'm weak at frames?" → list the events).

### 3.1 Knowledge components (KCs)
A KC is a unit of skill or knowledge, e.g. `spatial-algebra.force-transform`,
`cpp.std-span`, `quaternion.exp-map-side`. Each KC has:

- `theta`, `n`: ability estimate and evidence count (uncertainty-weighted Elo/logistic
  model; see `pedagogy-model.md` §2, chosen over BKT per evidence T3), updated only by
  evidence events, by code.
- `mastery_state`: unseen → introduced → practising → provisional → durable.
- `memory`: FSRS state (stability, difficulty, due date) for spaced review.
- `evidence[]`: links to events (drill answers, checkpoint results, explanation judgements).
- `source`: `interview`, `observed`, or `stated`.

KCs live in a **global** namespace per profile (`skills-global.json`), so "quaternions" learned
in the physics project count when a later graphics project needs them. That is the shared
cross-project memory you asked for.

### 3.2 Preferences: stated vs observed
```json
{
  "stated":   { "explanation_density": "concise", "wants_visuals": true, "language": "en" },
  "observed": { "opens_explorables_rate": 0.82, "reads_think_first": 0.9,
                "median_hint_level": 1.4, "session_length_min": 55,
                "best_engagement": "predict-then-reveal explorables" },
  "agent_notes": [ { "text": "Responds well to bug-hunts in his own code", "evidence": ["ev_…"] } ]
}
```
Stated preferences are respected because they matter for motivation and autonomy. They are
not treated as a learning mechanism (see `learning-science.md` on learning styles).

### 3.3 Misconceptions
Each misconception has an id, a description, the KCs it touches, evidence, a status
(`suspected → confirmed → addressed → resolved`), and the intervention used. Resolving one
needs *evidence* (e.g. a correct transfer question later), not just the agent's word.

### 3.4 Every change is a proposal, every proposal is undoable
Applies to **everything the agent changes**: lessons, learner data, curriculum, insights.

- The agent never writes files. It calls MCP tools (`propose_learner_update`,
  `revise_lesson`, …) that produce a **change record**:
  ```jsonc
  { "id": "chg_…", "at": "2026-10-05T21:14:03Z",
    "agent": { "name": "claude-code", "model": "claude-opus-5-5", "session": "ses_…" },
    "target": "learner/model | lessons/09 | curriculum | insights",
    "patch": [ /* JSON Patch */ ], "inverse": [ /* precomputed undo */ ],
    "reason": "Struggled on 3 frame-transform probes rated easy",
    "evidence": ["ev_…", "ev_…"], "status": "pending | applied | rejected | reverted" }
  ```
- ⚙ validates schema and ownership (the agent adds evidence and hypotheses; ⚙ computes
  scores), rate-limits, and applies.
- **Two modes, chosen by the learner (per profile, switchable any time):**
  - **Review** (default): changes queue in a "Proposed changes" panel; accept / reject each or
    all.
  - **Auto-apply** ("bypass"): changes apply immediately and appear in the history.
- **Always undoable, in both modes.** The History timeline lists every change with its time,
  model, session, reason, and evidence. Undo / redo per change, or **bulk revert by filter**
  ("everything model X changed in session Y", "everything since Tuesday"). Undo of a change
  that later changes depend on shows those dependants and offers to revert them together.
- **No keyboard shortcut** undoes agent changes. Undo/redo are explicit buttons in the History
  panel and on each change card, so typing in the editor can never trigger them by accident
  (the editor's own Ctrl+Z only ever affects the learner's text).

### 3.5 Estimates go down as well as up
Skill estimates are never a ratchet:
- Every new piece of evidence can lower an estimate. If the learner struggles on something
  the interview rated as known, the next probes lower it.
- **Coming back after a break:** each KC's estimate is discounted by how much is likely to
  have been forgotten (the FSRS retrievability of its items since last practice). A project
  reopened after weeks starts with a short "welcome back" check that re-anchors the estimates
  instead of assuming the previous peak.
- Because state is derived from the event log, a *wrong* batch of evidence (e.g. a model that
  judged explanations badly) can be reverted (§3.4), and every estimate is recomputed as if
  it never happened.

### 3.6 Teaching insights: hypotheses, with trust scores
The agent can record *how this learner seems to learn best*. These are always treated as
hypotheses, never as rules:
```jsonc
{ "id": "ins_…", "text": "Grasps ideas faster from the maths than from a real-life analogy",
  "scope": "global | project:<id> | kc:<id>",
  "support":    [ { "at": "…", "model": "…", "evidence": ["ev_…"], "note": "…" } ],
  "contradict": [ { "at": "…", "model": "…", "evidence": ["ev_…"] } ],
  "trust": 0.71 }            // computed by code, never set by the agent
```
- **Trust is computed by code** from how often the pattern was seen and contradicted, with
  older observations counting less:
  `trust = (s + 1) / (s + c + 2)`, where `s` and `c` are recency-weighted support and
  contradiction counts. A pattern seen once ≈ 0.67. Seen five times without contradiction ≈
  0.86. Seen and contradicted equally ≈ 0.5.
- The agent can *support* or *contradict* existing insights or add new ones, but it cannot
  set trust.
- In the teaching context, insights are presented as "hypotheses about this learner, with
  trust", sorted by trust. Low-trust ones are suggestions to try, not instructions.
- **Precedence:** a learner-specific insight can only override a research-based default when
  its trust is higher than that default's evidence confidence (`pedagogy-model.md` §14). A
  pattern seen once doesn't overturn a meta-analysis. A pattern seen ten times for *this*
  learner can.
- Learners see, edit, and delete insights on the Me page.

## 4. Multiple profiles on one device

- Each profile is a separate directory. Nothing is shared between profiles except `system/`.
- The core serves **one profile per session**. Every API call and MCP tool is bound to the
  session's profile id, so there is no cross-profile path anywhere in the tool surface.
- Project ids are random (UUIDv7), and path resolution always goes through the profile root
  with `..` and symlink escapes rejected (unit- and property-tested).
- The agent subprocess runs with a cwd inside the active project, and its generated config
  denies reads outside `<profile>/projects/<project>/` plus the workspace.

**Honesty about the threat model:** on one OS account, any program running as that user can
read unencrypted files. Real separation between people needs either separate OS accounts or
**profile encryption** (§5). The UI says so plainly when someone creates a second profile.

## 5. Encryption at rest (the user's choice, per profile)

Offered when a profile is created and can be turned on or off later. The default is **off**,
with a clear explanation of what encryption protects against on a shared computer.

- A passphrase → Argon2id → key; files encrypted with XChaCha20-Poly1305 (libsodium), or the
  `age` format so users can decrypt with standard tools if the app dies (no lock-in).
- Workspaces are *not* encrypted. They are the user's normal repos.
- Trade-off: encrypted profiles can't be read by external tools, and the agent only ever sees
  them through MCP. That is fine, because that is the intended path anyway.

## 6. "Prevent the LLM from collecting data", stated honestly

Anything sent to a hosted model reaches its provider. The app can't change that. What it *can*
do:

1. **Minimise:** the agent gets a *purpose-built summary* (`get_teaching_context`), not the raw
   profile. Name, email, and free-form personal notes are excluded by default.
2. **Scope:** no file access outside the active project and workspace. No access to other
   profiles or other projects' raw data (cross-project knowledge comes only through KC
   summaries).
3. **Show:** a "context inspector" shows exactly what was sent in each turn.
4. **Choose:** the user picks the agent. A local model (Ollama + an ACP agent) means nothing
   leaves the machine, at the cost of teaching quality.
5. **No app telemetry**, ever. No network calls by the core except to the agent subprocess and
   (optional) links the user opens.

## 7. Durability

- Atomic writes (write temp → fsync → rename), one writer (the core), file locks.
- Every schema has a `schemaVersion`. Migrations are pure functions, each one unit-tested with
  fixtures from every previous version.
- Export/import of a profile as a single archive (encrypted if the profile is).
- The event log is append-only and monthly, so a corrupt month never touches older history.
