# Roadmap

Where Aporia stands, and the order of the work ahead. Each phase has an **exit test**: the
phase is done when that test passes, not when its list is ticked.

## Where we are (v0.2 in progress, October 2026)

Working end to end on a real Claude login. Phase 1 is built; what's left is its exit test, a
full Heavy Metal Physics lesson cycle in the app.

- **Foundations (v0.1):** profiles, projects, undoable history, an open learner model. The agent
  sees only its own tools and authors validated lessons; lessons render maths, 2D/3D diagrams,
  plots, explorables and drills; you can ask about any selection; an Electron shell.
- **Learning loop (6 October):** progress and conversations persist; checkpoints run your tests;
  spaced review; a structured interview that scores its own probes; the project path and plan;
  the solution gate; agent status and login help; an embedded editor; a first brain view.
- **Starting from existing work (7 October):** a folder picker; files imported at creation or in
  the chat (PDF, HTML, Markdown, code); what the tutor may write (external tests, tool folders
  such as a viewer, reviewed edits to your files) chosen at creation and in the settings; skills
  the repo suggests recorded as claims and probed before they count; a project roadmap whose
  milestones you accept, reject or undo.
- **Teaching behaviour:** two-tier multiple choice (an answer, then the reason), research-backed
  (R8); the tutor judges an answer from a lesson, helps briefly, then sends you back to it with
  a link, and adds practice to the lesson (`add_to_lesson`) instead of setting exercises in the
  chat.
- **Crash-proof:** a crashed page reloads itself and a crashed GPU process repaints; Ctrl+R/F5
  reloads; errors stay in the part of the screen they happen in; `logs/app.log` records every
  incident. A restart reopens where you were (profile, project, lesson, panel, open file), keeps
  unsaved editor text, and resumes the tutor's own session (a cut-off turn offers Continue).
- **Tests:** 595 unit and integration tests at 100% function coverage, plus Electron checks
  (`npm run e2e:desktop`: smoke, editor, crash recovery).

## Phase 0: Identity

The design makeover: the CoachForce typographic family (Satoshi, Sentient, Pixelify Sans) and
a distinctive look built around "an instrument for thinking".

**Exit test:** the app is recognisable from a screenshot, and reads comfortably for an hour.

## Phase 1: Usable for my own learning (v0.2)

Everything needed to learn Heavy Metal Physics in Aporia instead of in artifacts.

| # | Work | Why |
|---|---|---|
| 1.1 | **Lesson progress persists**: drill answers, predictions, reveals, explorable predictions and task status are saved and restored. A lesson remembers where you were. **Done**, along with saved tutor conversations | Today a reload loses your place |
| 1.2 | **Checkpoint runner**: run the project's test command (filtered by suite), parse pass counts, show the ladder, and record evidence. **Done**: no shell, `{suite}` placeholder, 12 test-output formats, evidence once per reached step, results in the tutor's context | Step-level feedback is the most effective tutoring signal (T1) |
| 1.3 | **Structured interview**: probes rendered as real activities, results in `assessment.json`, KC graph drafted and shown. **Done**: probes with answer keys are scored by the app (choices, numbers, spot-the-line), scales record self-rating priors; the tutor saves the assessment and describes the profile's skill map | The first lesson must start at the right level (W2, W6) |
| 1.4 | **Curriculum view**: the KC graph as a path, lesson planning (next 2–3 detailed), "what's next". **Done** (the Path page) | Orientation and autonomy (MO1) |
| 1.5 | **Review queue**: FSRS-scheduled items from past lessons, a review screen, warm-ups pulled from due items. **Done**: warm-up items carry `reviewOf` so their answer reschedules the original | Spacing and retrieval are the strongest effects we have (R1, R3) |
| 1.6 | **Solution reveal gate**: code-shaped answers that match an open task are hidden behind "show anyway". **Done** | Closes the remaining leak path (architecture §8, finding 3) |
| 1.7 | **Agent UX**: detect "not logged in" or "agent missing" and show what to do; show agent status; stream Markdown smoothly. **Done** | The first run must not be confusing |
| 1.8 | **Embedded editor** (Monaco), optional next to the external-editor flow. **Done**: syntax highlighting only (no language services), saves never overwrite changes made in another editor | Code next to the lesson |

### 1.9 Starting from existing work (added 7 October 2026)

- **Folder picker** (the system dialog in the desktop app, an in-app browser otherwise).
- **Files** dropped or picked at project creation or any time in the tutor chat, copied into the project.
- **What the tutor may do**, chosen at creation and in the settings: tests (external, in a folder of their own),
  supporting code in named folders (e.g. the viewer), measurements (the tests and listed commands), edits to the
  learner's files (always reviewed), and free-form notes. Every write is an undoable change.
- **Claims**: the tutor reads the repo and the files, records what they suggest as claims ("to verify"), and probes
  them; only evidence moves a level.
- **Roadmap**: the project's milestones, proposed one change per milestone, each accepted, rejected or undone.

### 1.10 Reviews that test the skill, not the question (added 9 October 2026)

The Review page showed a lesson's own drill items, taken out of the lesson and scheduled one by
one. Two problems made it close to useless:
- Out of their lesson, most items lack context: they lean on terms, code or figures the lesson
  had just shown.
- The same item comes back every time, so a review tests whether the learner remembers that
  question, not whether they understood what it was testing.

What changes:
- **The skill is scheduled, not the question.** FSRS keeps one memory state per skill, folded
  from every answer that tests it (drills, warm-ups, predictions, reviews). Nothing to migrate:
  the journal is folded again.
- **A question bank per project, apart from the lessons.** Review questions are written for
  review: each one carries the context it needs (definitions, code, numbers), the skills it
  checks, and its angle (apply, explain, predict, spot the error, compare, recall). The bank is
  a profile document, validated on every change.
- **Never the same question twice in a row.** For each due skill, the app picks a question the
  learner has not answered yet, from a different angle than last time when it can. A question
  with number placeholders gets new numbers each time it comes back. Only when nothing new
  exists does an earlier question return, marked as seen before, and never the one from last
  time if there is another. A question that covers two due skills reviews both.
- **Self-contained, enforced.** The tutor writes questions through `write_review_questions`. The
  app refuses a question that points back at the lesson ("the diagram above", "as we saw", "in
  this lesson"), a copy of an earlier question or of a lesson item, a kind the app cannot score
  on its own, and a template whose numbers do not work out. Every question has a "Doesn't make
  sense without the lesson" button: it retires the question, keeps that answer out of the
  learner model, and asks for a replacement.
- **Where new questions come from is the learner's setting:**
  - **A pool, written ahead (default).** After the learner answers in a lesson or a review, the
    tutor writes new questions in the background for the skills running low (fewer than two
    unseen), soonest due first. Review opens at once; it uses some of the learner's agent usage.
  - **When due.** Opening Review asks the tutor for questions on the due skills that have
    nothing new; the page waits for them.
  - **Numbers only.** The tutor writes each skill's questions once, as number templates where it
    can, and the app gives them new numbers each time. No more tutor calls, but conceptual
    questions come back as they were.
- **Questions never wait for approval.** Approving a review question would show its answer, so
  they apply directly; they stay in History, undoable.
- **The lesson warm-up follows.** The tutor gets the due skills and writes new questions on them
  instead of copying an earlier item (`reviewOf` is no longer needed).

**Built** 9 October 2026; the exit test below needs a week of real use.

**Exit test:** a day after a lesson, Review shows each due skill with a question I have not seen
and can make sense of without opening the lesson. A week later the same skills come back with
different questions. Flagging a question replaces it. With "numbers only", no tutor call
happens and numeric questions come back with new numbers.

**Phase 1 exit test:** I finish one full Heavy Metal Physics lesson in the app: interview → lesson →
build with checkpoints → next-day review. I never have to leave the app except for my own
editor, and no state is lost across restarts.

## Phase 2: Teaching quality (v0.3)

Make the tutor measurably good, not just functional.

| # | Work |
|---|---|
| 2.1 | **Hint ladder enforced**: hint level recorded per task, attempt gating for L4+, level visible to the learner (H1–H2). **Done**: the tutor calls `record_hint` before a hint and the app enforces the ladder (start at L0–L1, one level at a time, L4+ only after a checkpoint run, a change to the task's files or a written attempt); each task shows its ladder; evidence on the task, checkpoints included, counts the hints |
| 2.1b | **Test results the app can read**: every test the tutor writes is declared by name before it runs and reports its result to the app, so each one shows by name as passed or failed, even when nothing compiles (then every one of them fails). See below |
| 2.2 | **Difficulty controller and activity mix fed into authoring**: scaffold level, success band and the mix of code and questions passed to the agent and checked by the validator (§3–§5), with bounded learner control. See below |
| 2.3 | **Misconceptions** as first-class objects (suspected → resolved), surfaced on the Me page |
| 2.4 | **Catalog v2**: `animation`, `simulation`, `manipulate` (drag), `math-input` with equivalence checking, `fill-in`, `sketch-answer` |
| 2.4b | **Exercises**: small runnable practice inside a lesson (replaces `code-run`). See below |
| 2.5 | **Lesson revisions as diffs**: the agent's edits shown inline with keep/revert |
| 2.6 | **Agent eval suite**: scripted learner scenarios plus rubric judging, run across models; the score must not regress when the rules change (quality §4) |
| 2.7 | **Research base files** (`system/research/`) with every ○ citation verified, plus a `search_research` tool |
| 2.8 | **Brain view**: the profile's whole skill graph as one big map, see below. **Second version done** (nested groups, folding by zoom, colours by area; map, list, details, suggestions, struggles) |

### 2.1b Test results the app can read

Today a checkpoint reads the summary line a test runner prints, in one of 12 known formats.
That is fine for the learner's own suites, but the tests the tutor writes have no requirements
at all. When their output is in a format the app does not know, or the build fails before any
test runs, the app learns nothing: no names, no states, just a raw log. A test the tutor writes
must tell the app at least its name and whether it passed, and the app must be able to say so
even when nothing compiles.

**The rule:** a tutor-written test passes only when its run reports a pass. Everything else
(a failure, a skip, a build that broke, a crash, a test that never reported) is a failure,
shown under that test's name.

- **Tests are declared before they run.** A program that never compiled cannot report anything,
  so the names cannot come from the run. The tutor writes a suite through one tool (e.g.
  `write_tests`) that writes its files and declares its tests together: the suite's name, and
  for each test a stable id, a readable title, and optionally the skills it checks and the
  lesson anchor it belongs to. The declaration is a change in the profile (reviewable,
  undoable), not a file a run could alter, so the app always knows which tests to expect.
- **Results go to a report, not the console.** Build tools capture, reorder or hide what tests
  print (CTest, cargo, parallel runners). For each run the app makes a fresh, empty report
  folder and passes it to the learner's test command in `APORIA_TEST_REPORT_DIR` (with
  `APORIA_TEST_SUITE`). Each test process writes its own JSON Lines file there, one event per
  line: `{"v":1,"event":"start"}` as soon as the test program runs, one result per test
  (`{"v":1,"event":"result","test":"quat-unit-length","status":"pass"}`), and
  `{"v":1,"event":"end"}` when it finishes. `test` and `status` (`pass`, `fail`, `skip`,
  `error`) are required; everything else is optional. A file per process is safe with parallel
  runners, and a crash mid-run keeps the lines already written.
- **The app fills in what a run did not say.** After every run, each declared test gets exactly
  one state:

  | What the run produced for the test | State | Shown as |
  |---|---|---|
  | `pass` | passed | ✓ |
  | `fail` or `error` | failed | its message, expected and actual |
  | `skip` | failed | "skipped" |
  | nothing; no `start` anywhere; the command failed | failed | "did not compile", with the first error |
  | nothing; no `start` anywhere; the command succeeded | failed | "not run: your test command does not run this suite", with how to add it |
  | nothing; a `start` but no `end` | failed | "crashed or stopped before this test ran" (or "timed out") |
  | nothing, though the run started and ended | failed | "did not report": a defect in the tests |

  A test reported twice fails if either report fails. Results for ids nobody declared are shown
  apart and counted nowhere. Unreadable lines are skipped and counted. The ladder counts passed
  tests only.
- **Whose fault it is, for the learner model.** Every failure is shown, but not every failure is
  evidence about the learner. When the build's first errors point into the tests folder, when a
  test "did not report", or when the ids do not match the declaration, the tutor's tests are
  what is broken. That run is marked as such, records no evidence, does not count as an attempt
  for the hint ladder (2.1), and the tutor is told what to fix. Errors in the learner's own
  files count as they do today. Error locations are read from the usual compiler formats (GCC
  and Clang, MSVC, rustc, tsc, Python tracebacks); when the app cannot tell, it blames no one.
- **More data, within limits.** A result may also carry a `message`, `expected` and `actual`,
  the `file` and `line` of the check, `durationMs`, named numbers (`metrics`), and data for a
  figure (a series or points), which the app draws with its own plot and 3D components, as for
  exercises (2.4b); never HTML or code. A line is at most 64 KB and a report at most 8 MB:
  anything past that is cut and flagged. Every line is checked against the schema, and only what
  passes is kept.
- **Enforced when the tests are written.** `write_file` refuses test files in the tests folder:
  tests go through the suite tool. The validator refuses a suite whose declared ids do not all
  appear in its files, and a checkpoint on a suite in the tests folder that was never declared.
  A checkpoint names the tests a step expects to pass (`expect: { tests: [...] }`), so the
  ladder is about named tests, not only a count; counts stay for the learner's own suites.
- **Reporters come from the app.** So the format is always right, the app ships small reporters
  that the tutor installs into the tests folder through a tool and never writes itself:
  listeners or plugins for GoogleTest, Catch2, pytest, Vitest and Jest, Go and cargo, plus a
  plain header or module for tests without a framework. A reporter writes `start` the moment the
  test program runs, so a missing `start` reliably means "never ran". (To decide: also read
  JUnit XML where a framework writes it natively, under the same rules.)
- **What the learner sees.** Under the task, every declared test by its title and state; for a
  failure, its message and the lesson section it belongs to, never the fix (ux §4). A broken
  build shows once, at the top, with its first error and the full output folded. What changed
  since the last run stands out: newly passing tests, and regressions.
- **What the tutor sees.** The same results in its context (failing tests with their messages,
  regressions, the first build error, and any defect in its own tests), and from `run_tests`
  when it checks its work.
- **The learner's own tests are unchanged.** Suites the learner wrote keep today's output
  parsers. They can install a reporter themselves to get named results.
- **Not a security boundary.** The learner's code runs in the same process as the tests and
  could write to the report. That would be the learner fooling themselves, not an attack: this
  contract is about the tutor's tests being reliable.

Builds on 1.2 (checkpoint runner) and 2.1 (hint ladder). Exercises (2.4b) depend on it.

**Exit test:** in a C++ project whose stub does not compile yet, the tutor writes a suite of six
tests. The task lists all six by name, failed, "did not compile", with the first compiler error.
Once the code compiles and one test crashes, the tests after it show "crashed or stopped before
this test ran". A typo in a declared id is reported as a defect in the tutor's tests, and no
evidence is recorded. The same works in a Python project. Taking the suite out of the test
command shows "not run" with how to add it back.

### 2.2 The activity mix, and what the learner can change

How much of a lesson is writing code and how much is answering questions is a teaching
decision, so evidence sets it. The learner gets a few meaningful choices, never a free
theory/practice slider: people prefer what feels fluent (reading), which is not what works
(retrieval, production), and either extreme hurts a novice (passive time, or problem solving
without examples).

- **An evidence-based default.** Each skill's type and the learner's level choose the activity
  sequence (pedagogy-model §3): procedural skills lean on code (worked example → completion →
  write), conceptual ones on questions (predict, contrast, explain-back). The agent gets the
  sequence and a time budget per lesson; the validator checks the result, including ≥ 50% of
  the time in active work. Today the agent sees a recommended scaffold level and nothing more.
- **A one-step nudge per lesson:** "more explanation" or "more hands-on" moves the mix one step,
  within limits. At least half of the lesson stays active, practice is never removed, and
  easing a novice's floor (worked examples, completion) is explained once. It works alongside
  scaffold ±1 and "harder / easier" (the success band).
- **Requests about the situation**, which shape one session, not the long-term mix: "short
  session", "away from my code" (no build tasks), "explain before I build".
- **Choices are evidence about the learner, not settings.** A repeated preference is recorded as
  an insight (a hypothesis with trust). It shapes future lessons if outcomes hold up; if they
  do not, the tutor says so and steers back.

**Exit test:** two lessons on the same project, one about a procedural skill and one about a
conceptual one, come out with visibly different mixes without any input; a nudge changes the
next lesson by one step and never below the active-work floor.

### 2.4b Exercises

Project tasks are big, so a recurrent skill (quaternion products, Python's `print`) gets
exercised once, inside a lot of other work. Exercises are small, repeated, runnable practice
on one skill, embedded in the lesson where the tutor places them: part-task practice with
immediate step-level feedback (T1, W3), the "completion → write" steps of the procedural
sequence (pedagogy-model §3), and what `add_to_lesson` adds when the tutor thinks the learner
needs practice.

- **Scope:** one skill (or two confusable ones), 5–15 minutes. Part of the lesson, not of the
  project or its roadmap. Files live in the profile (`projects/<id>/exercises/<id>/`), never in
  the learner's repo.
- **Starter file:** written by the tutor and validated like a stub (no solution). Its form
  follows the scaffold level: fill in blanks, a function from its contract, or a short program
  from a goal; a Parsons puzzle first for novices.
- **Editing:** the embedded editor (Monaco) inside the lesson, kept as a draft while typing.
- **Running:** through the checkpoint runner (no shell, time limits, the learner's own
  toolchain). Three checks: **tests** (pass/fail by name, reported as in 2.1b), **output**
  (stdout against what is expected), **visual** (the program prints data, e.g. points, frames,
  a series, which the app draws with its own plot and 3D components from a spec the tutor
  wrote; never tutor-written HTML or JavaScript). E.g. plot |q| over 10,000 integration
  steps and watch it drift.
- **Evidence:** every attempt is evidence (first try or not, hints used), feeding the skill
  ratings and the difficulty controller.
- **Coming back:** a passed exercise joins spaced review. When it is due, the tutor writes a
  variation (same skill, new numbers or context) for a warm-up, through `reviewOf`.
- **Transfer:** some exercises put the skill in another context on purpose (quaternions for a
  camera instead of a joint), the bounded version of a "side project" (R2).
- **The usual guards:** hint ladder, solution gate in the chat, hand back to the lesson.
- **Safety:** tests are tutor-written code that runs on the learner's machine, so exercises need
  a permission (the "tests" one or their own), and the test file is always visible.

Depends on 1.2 (checkpoint runner), 1.8 (editor), 2.1b (test results) and 2.2 (scaffold level picks the form).

**Exit test:** in a Heavy Metal Physics lesson, the tutor adds a quaternion exercise after a
weak answer; I write it in the lesson, run it until it passes, and a variation of it shows up
in a warm-up when it is due.

### 2.8 Brain view

A map of what you know, across every project in a profile. Skills are nodes and groups of
skills are clusters, laid out as one large graph that floats and settles under a gentle
physics simulation. You can drag it, zoom it, and follow the links.

- **Your level at a glance.** Each skill shows its mastery state and band, computed by code
  from evidence (D3, P4). How sure the app is shows too: a skill seen once looks fainter than
  one seen twenty times (§14 confidence).
- **Where you struggle.** Skills that are slipping (failed delayed retrievals, falling θ, due
  reviews piling up) and active misconceptions stand out, each linked to its evidence.
- **Undiscovered nodes.** Suggested skills you haven't touched yet, at the edge of what you
  know, show as dim nodes: "you could learn this next, because you know X and Y". A
  suggestion is never evidence and never changes a rating.
- **Per profile, and the agent can submit to it.** The graph lives in the profile (one skill
  namespace shared by all projects, data-and-privacy §3.1). The tutor proposes skills, groups,
  links and suggestions through a teaching tool. These are validated by code (ids, acyclic
  prerequisites), go through the normal change flow (review or auto, always undoable) and
  never carry a rating: the agent describes the map, and code colours it.
- **Calm, not a game.** Motion is subtle and stops when the layout settles. Reduced-motion
  users get a static layout. No points and no streaks (P7).
- **Domains, areas, skills (done, 8 October).** Groups nest (graphics programming ⊃ Vulkan ⊃
  synchronisation). Zoomed out, a group whose skills would crowd into a few pixels folds into
  one node sized by its skills and filled by how much of it is known; zooming out further folds
  areas into their domain. Click a folded group to open it. Folding can be turned off.
- **Colour is where a skill belongs (done).** Each domain gets a hue, in the order domains sit
  on the map; its areas get shades of it; each skill blends with the skills it links to (in
  OKLab), so a bridge between blue graphics and red simulation is purple. Related domains sit
  side by side and unrelated ones apart. How well a skill is known is the fill, never the colour.
- **Bridges as metaphors (idea).** The links between domains are where explanations can borrow:
  "a descriptor set is like the bind groups you know from WebGPU", "a spring-damper is the RC
  filter you built". The tutor could get the learner's strongest bridges into the skill it is
  teaching, and the validator could check that an analogy names a skill the learner really
  holds (durable, not just met).

**Exit test:** the eval suite passes on Opus and degrades gracefully on a small model. A full
lesson cycle shows mastery moving only on delayed and transfer evidence.

## Phase 3: Any subject, any source (v0.4)

| # | Work |
|---|---|
| 3.1 | **Source import**: PDF, Markdown and web pages, stored locally with anchors; `source-ref` component. **Partly done**: files (PDF with page markers, HTML, Markdown, text, code) dropped at project creation or in the chat are copied in; the tutor lists, reads and searches them. Not yet: `source-ref`, OCR |
| 3.2 | **Source-study lessons** and **exam-prep mode** (review scheduled toward a date) |
| 3.3 | **Non-code projects** polished: maths and physics theory, a course from imported papers |
| 3.4 | **Import old lessons** (the HMP artifacts) as history plus sources. **Partly done**: they import as sources, and the tutor records what they suggest as claims to verify |

**Exit test:** drop a university paper in, and get lessons and spaced reviews that cite its pages.

## Phase 4: Ready for other people (v1.0)

| # | Work |
|---|---|
| 4.1 | **Profile encryption** (opt-in, age format), export/import bundles |
| 4.1b | **Sync and backup** to storage the learner already has: a drive, a NAS, GitHub or any git host. See below |
| 4.2 | **Context inspector**: exactly what each turn sent to the agent |
| 4.3 | **Other agents**: settings UI for any ACP agent; tested with a local model (fully offline) |
| 4.4 | **Installers** for Linux (AppImage/deb), macOS (dmg) and Windows (exe); CI on all three; auto-update |
| 4.5 | **Claude Code plugin** packaging for terminal-only use |
| 4.6 | **Onboarding and docs**: first-run guide, contributor guide, docs site |
| 4.7 | Re-check Anthropic's terms for ACP/subscription use before public release |

**Exit test:** a friend installs it from a release page on a clean machine and learns something
without my help.

### 4.1b Sync and backup

A profile is the learner's: it lives on their machine, and they choose where a copy goes. No
Aporia server, ever. The app syncs to storage the learner already trusts, so learning on a
laptop tomorrow, or recovering from a dead disk, takes one setting.

- **Two kinds of target cover almost everything:**
  - **A folder**: a mounted drive, a NAS share (SMB, NFS), or a folder another tool syncs
    (Syncthing, Nextcloud, Dropbox, OneDrive, iCloud Drive). The app writes there; that tool
    does the rest.
  - **A git remote**: GitHub, GitLab, Codeberg, Gitea or Forgejo, or a bare repo on a NAS over
    SSH. You get history and off-site copies for free.
  - Later, if people ask: WebDAV and S3-compatible storage.
- **Encrypted before it leaves the machine** (4.1), on by default for anything that is not a
  local drive; the passphrase never goes with the data. Without it, the settings say plainly
  who can read what.
- **Built to merge, not just to copy.** Most of a profile is append-only and keyed by ids (the
  journal of evidence and changes, conversations, imported files), so two machines merge by
  union, and everything derived is rebuilt from the journal. The rare real conflict (the same
  document changed on both sides before a sync) is shown in History for the learner to pick,
  never resolved silently.
- **Only what belongs to the learner travels.** Machine-specific things stay: the window's
  place, logs, agent session ids. Workspaces map per machine ("on this laptop, Heavy Metal
  Physics is at ~/code/hmp"), asked for on first open.
- **When it syncs:** on open, on close, and every few minutes while a session runs. "In use on
  laptop since 14:02" is shown on the other machine, so two sessions at once are a choice,
  not an accident.
- **Restore:** pick a target and a date (git history, or the folder's snapshots) to get a
  profile back, onto a new machine or after a mistake.

Today the profile folder can be synced by hand: point `APORIA_DATA_DIR` at a git clone or a
synced folder, and push or pull around each session.

**Exit test:** I alternate lessons between two machines for a week, one of them offline for a
day, with sync through a private git repo and through a Syncthing folder. Nothing is lost or
duplicated, and a restore onto a third machine brings back every lesson and review.

## Phase 5: Beyond the desktop (post-1.0)

Mobile client of the desktop core (review and reading), French and other languages, a light
theme, and opt-in anonymised research exports (learning-science "Gaps").

## Always on

- `npm run check` green on every commit: 100% function coverage, strict types.
- A real-agent spike after any change to agent integration (`scripts/spike-*.ts`).
- Small, human commits. No learner data in the repo, ever.
