# Teaching engine

How a project goes from "I want to learn X" to a stream of lessons that adapt to the learner.
This doc describes the **flows**. The *rules* (which activity, how much help, when something
counts as mastered) are in `pedagogy-model.md`, and *what can be displayed* is in
`component-catalog.md`.

🧠 = LLM, ⚙ = deterministic code, 👤 = learner. Every 🧠 output passes a ⚙ validator before it
touches state.

## 1. Project lifecycle

```
 New project ─► Goal capture ─► Interview ─► Curriculum graph ─► Lesson loop ─► Capstone
   (👤 + UI)      👤 + 🧠          🧠 → ⚙         🧠 → ⚙              ↺            🧠 + ⚙
        ▲
        └── optional: import sources (papers, PDFs, notes, existing lessons) §6
```

### 1.1 Goal capture (👤 + 🧠)
A guided screen, not a blank box:
- *What do you want to build or understand?*
- *Why does it matter to you?* The learner **writes** this, and it becomes the utility-value
  anchor (MO5) reused in every lesson.
- *Is it a coding project?* → link or create a workspace folder, give the build/test command.
  **Not required:** non-code projects (maths, physics theory, a course from imported papers)
  work without a workspace. Their feedback comes from `math-input`, quizzes, explain-backs, and
  explorables instead of test suites. v1 puts the most polish into coding projects but gates
  nothing on code.
- *Sources?* → drop in PDFs, papers, slides, notes, links (§6).
- *Time per week, deadline, and when you'll study* → if-then plan (MO7).

### 1.2 Interview (🧠, structured by ⚙)
An adaptive diagnostic (`pedagogy-model.md` §10):
1. 🧠 drafts the KC map for the goal and shows it as a graph.
2. For each required cluster: self-rating (prior only) → **first-step probes** (explain,
   predict, spot the bug, sketch a layout), using binary search on difficulty.
3. Look for **misconceptions**, not just levels (W6).
4. Find **bridges**: adjacent experience to use as paired analogues (G4).
5. Stated preferences (density, theory-first vs build-first, how they handle being stuck),
   recorded as *stated*.
6. Play back the picture ("strong on X, shaky on Y, misconception Z; bridge via your voxel
   engine's transform hierarchy"), and 👤 corrects it.

⚙ output: `interview/assessment.json` → priors for θ, misconceptions, bridges, preferences.

### 1.3 Curriculum graph (🧠 proposes, ⚙ validates)
- Nodes = KCs (reusing the profile's global KCs). Edges = `prereq` (acyclic) and `confusable`.
- Lessons are **milestones on the learner's real project**, each stating the capability it
  unlocks (MO3).
- A **rolling plan**: only the next 2–3 lessons are detailed, and later ones get refined as
  evidence arrives.
- 👤 can reorder (within prerequisites), skip ("I know this" → short probe), or add goals.

## 2. The lesson loop

```
 ┌► ⚙ choose next lesson: graph + mastery + due reviews + 👤 choice
 │   ▼
 │  ⚙ choose the instructional form per KC (pedagogy-model §3) and the scaffold levels
 │   ▼
 │  🧠 author the lesson from catalog components ─► ⚙ validate (schema + composition rules)
 │   ▼                                               └─ rejected → 🧠 gets the reasons, retries
 │  👤 works: pretests, predictions, drills, code, checkpoints, questions
 │   ├─ questions ─► 🧠 answers under the help policy (pedagogy-model §6)
 │   ├─ evidence ──► ⚙ event log → θ, mastery, FSRS updated
 │   └─ confusion ─► 🧠 may revise the lesson (shown as a diff, 👤 accepts or reverts)
 │   ▼
 │  exit check + optional reflection ─► 🧠 lesson review (qualitative) ─► proposals ─► ⚙
 └──────────────────────────────────────────────────────────────┘
```

## 3. Lesson anatomy

| Section role | Contents (catalog components) | Evidence |
|---|---|---|
| `warmup` | 2–4 `drill`s from due reviews + confusable KCs | R1, R3, R6 |
| `hook` | Concrete problem in *their* project; `pretest` ("guess first"); `utility-link` | R5, MO5, MO8 |
| `concept` | `prose` + a required visual (`diagram`, `plot`, `memory-layout`, `explorable`) + `predict` / `think-first` | P2, P3, G3 |
| `practice` | `drill`, `trace-task`, `contrast-task`, `find-the-bug`, depending on the KC state | C1, C2, G4, G5 |
| `build` | `task`s with scaffold level + `checkpoint` ladder | T1, W2, W3 |
| `exit` | Transfer + production items, `explain-back`, optional `reflection` | R2, G2 |
| `open-loop` | The next unsolved problem | MO8 |

A **theory** lesson has no `build`, but still needs warmup, a constructive activity, and an exit
check. A **design review** lesson (like "Foundations Before Featherstone") reviews the
learner's code against invariants with `code{kind: trace}` and turns the findings into `task`s
for the learner to fix.

## 4. Task scaffold levels

⚙ picks the level from θ and the success band (`pedagogy-model.md` §3, §5). 👤 can request ±1.

| Level | Name | The learner gets |
|---|---|---|
| 4 | Guided | `analogue` worked example with subgoal labels + `stub` + sub-steps + hand-worked example |
| 3 | Completion | `stub` + contract + hand example + traps |
| 2 | Contract | `stub` + contract |
| 1 | Goal | Goal + checkpoint |
| 0 | Open | Problem only; the learner designs the API (a design review follows) |

For programming KCs at low θ, write tasks are preceded by `trace-task` and `drill{order}`
(Parsons) activities (C1, C2).

## 5. Lesson storage and validation

- 🧠 writes through MCP tools with structured JSON (component schemas). ⚙ stores that component
  tree as-is (`component-catalog.md` §2). Lessons and projects transfer between installs as
  single bundle files.
- ⚙ validation: schemas, KC references, files exist, checkpoint suites exist, **stub check**,
  **similarity check** for `api`/`analogue` vs the open tasks, composition rules
  (`pedagogy-model.md` §4), and accessibility fields.
- A rejection returns *agent-readable* reasons, and the attempt is logged. After 3 rejections
  the learner sees a "lesson couldn't be generated" message with the reasons. A broken lesson
  is never shown.
- Every agent edit is a change record (data-and-privacy §3.4): reviewed or auto-applied, always
  undoable.

## 6. Importing sources and existing lessons

Users can drop in **anything they want to learn from**: university papers, lecture PDFs,
slides, textbook chapters, notes, web pages, and later their old artifact lessons.

**Pipeline (⚙ unless marked):**
1. **Ingest** into `projects/<id>/sources/<source-id>/`: the original file + extracted text
   with stable anchors (page, section, paragraph). Extraction is local (PDF text layer; OCR
   optional, also local). Formats for v1: PDF, Markdown, plain text, HTML pages (saved
   locally), images (OCR). DOCX/PPTX later.
2. **Map** (🧠): source sections → KCs, with citations to anchors. ⚙ validates that the anchors
   exist.
3. **Teach from it** (`pedagogy-model.md` §11): pretest → short section → retrieval/explain →
   spaced review. Lessons cite passages with `source-ref`.
4. **Exam-prep mode** (optional): target date → review scheduling tuned to it.

**Importing old lessons (e.g. your HMP artifacts):** treated as a source *plus* history. 🧠
converts each lesson into catalog components (best effort, validated). Lessons marked
"completed" seed evidence at low weight, and the learner confirms which ones they actually
did. This is planned **after** the core is proven (your answer to Q8).

**Privacy:** imported files stay local. They reach the model only when the agent reads them
for a lesson, which the context inspector shows. Copyrighted material is never uploaded
anywhere by the app.

## 7. Adaptation loop

After each lesson (and lightly after each session):
- ⚙ signals: success rate vs the band, hint distribution, time vs estimate, warm-up recall,
  calibration, engagement with optional activities, attempts per checkpoint.
- 🧠 qualitative review (stored as a file, visible to 👤): which explanations and analogies
  landed, misconceptions observed, suggested adjustments → `propose_learner_update`.
- The next lesson changes: scaffold levels, density, theory/practice ratio, choice of
  analogies, review items queued, lesson size.

## 8. Teaching rules (read-only system files)

Loaded for the agent on every relevant turn via `get_teaching_context`:
- `constitution.md`: principles, with allowed/forbidden reply examples.
- `help-policy.md`: hint ladder H1–H6 with worked examples.
- `component-catalog.md`: the agent-facing version (semantics, no styling).
- `lesson-authoring.md`: composition rules, quality rubric, exemplar lessons.
- `interview-protocol.md`, `answering-questions.md`, `rubrics/`.
- `research/`: the evidence base, searchable and citable.

Everything is model-agnostic prose plus schemas. A weaker model follows them less well, and
the validators keep it from producing broken state.
