# Vision and principles

## Vision

A workbench for learning through real projects, where an LLM acts as tutor, curriculum designer,
and reviewer, but never as the person doing the work. The goal is to make the *process* of
understanding rewarding, not to finish tasks faster.

The first user is the author, learning the physics behind `heavy-metal-physics`: spatial
algebra, Featherstone's articulated-body methods, constraints, contact, and breakage. The design
has to generalise to *any* learner and *any* project. Physics is the first real test case, not
a special case.

## Where the design comes from

The Heavy Metal Physics lessons published as artifacts (Sept–Oct 2026) already show a format
that works, and the app should formalise it:

- A titled lesson with a short **standfirst** that frames the problem in terms of the learner's
  own code.
- Numbered **sections** that build intuition before formalism.
- Interactive **explorables** that show *why*, for example "nudge a quaternion three ways, one of
  them right".
- **Drills** before implementation ("before you write it").
- A **build ladder**: ordered steps, each with files, maths, a "think first" prompt, traps, and
  a **checkpoint** measured against a staged test suite ("about 41 / 148 should pass").
- **Design reviews** of the learner's own code ("Foundations Before Featherstone"), anchored in
  invariants rather than authority.

What the artifacts can't do, and the app must: remember the learner across lessons, enforce
the "don't hand out solutions" rule, run the checkpoints automatically, let the learner ask
about any selected passage, and work with any model.

## Principles

These are *constitutional*. Every feature proposal is checked against them.

**P1. The learner produces the solution, and is never shown it by accident.** The point is to protect
learners who want to learn from being flashed the answer, not to stop someone who goes looking
for it elsewhere. The agent may explain, question, show analogous
examples, give stubs, describe data layouts, and review. It may not write the code or the
derivation the task asks for. The app enforces this with the permission gate described in
`architecture.md` §5. A prompt alone is not trusted to do it.

**P2. State lives in files, never in the model.** Anything that must survive a session is
written to a local file that the app's schema validates. The agent reads context from files at
the start of every interaction. Swapping Opus for a small local model changes how *good* the
teaching is. It does not change what is *remembered*.

**P3. Deterministic where possible, LLM where necessary.** Mastery estimates, review
scheduling, prerequisites, reward accounting, test runs, and schema validation are plain code
with unit tests. The LLM handles what only it can do: explaining, judging free-form answers,
writing lessons, and picking up qualitative signals. Its outputs are *proposals* that code
validates before anything is committed.

**P4. Evidence over self-report.** "I know linear algebra" is a hypothesis. The learner model
records stated beliefs and observed evidence separately and weights evidence higher. This also
follows from the research: people misjudge their own competence and learning (see
`learning-science.md`, "Metacognition").

**P5. Local, private, owned.** No telemetry. No cloud sync unless the user sets one up. Each
profile is isolated and can be encrypted. The agent sees a minimal, purpose-built view of the
learner model, not the raw files.

**P6. Adapt to prior knowledge, not to "learning styles".** Personalisation follows what the
research supports: prior knowledge (expertise reversal), pacing, the right level of challenge,
interests used as context, and stated preferences treated as *preferences* (respected for
motivation) rather than as a learning mechanism (see `learning-science.md`).

**P7. Motivation through competence, autonomy, and curiosity, not manipulation.** No
loss-aversion streak traps, no variable-ratio loot boxes, no notifications designed to guilt the
user. Rewards make progress *visible* and *meaningful*.

**P8. Never break.** Projects, lessons, and profiles are versioned, migrated by schema version,
and written atomically. A crash or a bad agent output never corrupts state. A malformed lesson
is rejected and reported. It is never half-applied.

**P9. Agent-agnostic by protocol.** Integration happens only through open protocols (ACP for
driving the agent, MCP for the tools the agent can call). There are no hidden dependencies on a
single vendor.

## Non-goals (for v1)

- Multiplayer classrooms or teacher dashboards. Single-user and multi-profile only.
- A hosted service. The app never runs a server that holds user data.
- Generating credentials or certificates.
- Replacing a full IDE. The app embeds an editor and works with your own editor as well.
- Mobile, for the MVP. The architecture stays cross-platform so it can be added later (see
  `architecture.md` §7).
