# Roadmap

Where Aporia stands, and the order of the work ahead. Each phase has an **exit test**: the
phase is done when that test passes, not when its list is ticked.

## Where we are (v0.1, October 2026)

Working end to end on a real Claude login:

- Profiles, projects, undoable history, an open learner model.
- The agent can't write files, sees only its own tools, and authors validated lessons.
- Lessons render maths, 2D/3D diagrams, plots, explorables and drills.
- You can ask about any selection; there is an Electron shell.
- 312 tests.

What's missing for real use: several core teaching loops (checkpoints, spaced review, a real
interview), persistence of what you did *inside* a lesson, and polish.

## Phase 0: Identity (now)

The design makeover: the CoachForce typographic family (Satoshi, Sentient, Pixelify Sans) and
a distinctive look built around "an instrument for thinking".

**Exit test:** the app is recognisable from a screenshot, and reads comfortably for an hour.

## Phase 1: Usable for my own learning (v0.2)

Everything needed to learn Heavy Metal Physics in Aporia instead of in artifacts.

| # | Work | Why |
|---|---|---|
| 1.1 | **Lesson progress persists**: drill answers, predictions, reveals, explorable predictions and task status are saved and restored. A lesson remembers where you were. **Done**, along with saved tutor conversations | Today a reload loses your place |
| 1.2 | **Checkpoint runner**: run the project's test command (filtered by suite), parse pass counts, show the ladder, and record evidence | Step-level feedback is the most effective tutoring signal (T1) |
| 1.3 | **Structured interview**: probes rendered as real activities, results in `assessment.json`, KC graph drafted and shown | The first lesson must start at the right level (W2, W6) |
| 1.4 | **Curriculum view**: the KC graph as a path, lesson planning (next 2–3 detailed), "what's next" | Orientation and autonomy (MO1) |
| 1.5 | **Review queue**: FSRS-scheduled items from past lessons, a review screen, warm-ups pulled from due items | Spacing and retrieval are the strongest effects we have (R1, R3) |
| 1.6 | **Solution reveal gate**: code-shaped answers that match an open task are hidden behind "show anyway" | Closes the remaining leak path (architecture §8, finding 3) |
| 1.7 | **Agent UX**: detect "not logged in" or "agent missing" and show what to do; show agent status; stream Markdown smoothly | The first run must not be confusing |
| 1.8 | **Embedded editor** (Monaco), optional next to the external-editor flow | Code next to the lesson |

**Exit test:** I finish one full Heavy Metal Physics lesson in the app: interview → lesson →
build with checkpoints → next-day review. I never have to leave the app except for my own
editor, and no state is lost across restarts.

## Phase 2: Teaching quality (v0.3)

Make the tutor measurably good, not just functional.

| # | Work |
|---|---|
| 2.1 | **Hint ladder enforced**: hint level recorded per task, attempt gating for L4+, level visible to the learner (H1–H2) |
| 2.2 | **Difficulty controller fed into authoring**: scaffold level and success band passed to the agent and checked by the validator (§5) |
| 2.3 | **Misconceptions** as first-class objects (suspected → resolved), surfaced on the Me page |
| 2.4 | **Catalog v2**: `animation`, `simulation`, `manipulate` (drag), `math-input` with equivalence checking, `fill-in`, `sketch-answer`, `code-run` |
| 2.5 | **Lesson revisions as diffs**: the agent's edits shown inline with keep/revert |
| 2.6 | **Agent eval suite**: scripted learner scenarios plus rubric judging, run across models; the score must not regress when the rules change (quality §4) |
| 2.7 | **Research base files** (`system/research/`) with every ○ citation verified, plus a `search_research` tool |

**Exit test:** the eval suite passes on Opus and degrades gracefully on a small model. A full
lesson cycle shows mastery moving only on delayed and transfer evidence.

## Phase 3: Any subject, any source (v0.4)

| # | Work |
|---|---|
| 3.1 | **Source import**: PDF, Markdown and web pages, stored locally with anchors; `source-ref` component |
| 3.2 | **Source-study lessons** and **exam-prep mode** (review scheduled toward a date) |
| 3.3 | **Non-code projects** polished: maths and physics theory, a course from imported papers |
| 3.4 | **Import old lessons** (the HMP artifacts) as history plus sources |

**Exit test:** drop a university paper in, and get lessons and spaced reviews that cite its pages.

## Phase 4: Ready for other people (v1.0)

| # | Work |
|---|---|
| 4.1 | **Profile encryption** (opt-in, age format), export/import bundles |
| 4.2 | **Context inspector**: exactly what each turn sent to the agent |
| 4.3 | **Other agents**: settings UI for any ACP agent; tested with a local model (fully offline) |
| 4.4 | **Installers** for Linux (AppImage/deb), macOS (dmg) and Windows (exe); CI on all three; auto-update |
| 4.5 | **Claude Code plugin** packaging for terminal-only use |
| 4.6 | **Onboarding and docs**: first-run guide, contributor guide, docs site |
| 4.7 | Re-check Anthropic's terms for ACP/subscription use before public release |

**Exit test:** a friend installs it from a release page on a clean machine and learns something
without my help.

## Phase 5: Beyond the desktop (post-1.0)

Mobile client of the desktop core (review and reading), French and other languages, a light
theme, and opt-in anonymised research exports (learning-science "Gaps").

## Always on

- `npm run check` green on every commit: 100% function coverage, strict types.
- A real-agent spike after any change to agent integration (`scripts/spike-*.ts`).
- Small, human commits. No learner data in the repo, ever.
