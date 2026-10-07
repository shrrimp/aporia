# Decisions and open questions

**Decided** = agreed, safe to build on. **Proposed** = my recommendation, waiting for you.
**Open** = needs your input.

## Decided

| # | Decision | Doc |
|---|---|---|
| D1 | The app never handles credentials. It spawns the user's own logged-in agent through **ACP**, and teaching tools go through **MCP**. It also ships as a Claude Code plugin | architecture §1–2 |
| D2 | "Never show the solution" is **enforced by code**, as protection against the model's mistakes for a learner who wants to learn. It is not meant to stop a user who goes looking for the answer elsewhere | architecture §2, vision P1 |
| D4 | **Everything the agent changes is a change record** (lessons, learner data, curriculum, insights) with time, model, session, reason, and evidence. Two modes: **review** (default) or **auto-apply/bypass**. **Always undoable**, including bulk revert by filter. Undo/redo are **UI buttons only, never a keybind** | data-and-privacy §3.4, ux §1 |
| D5 | **A lesson is stored as the component document the agent wrote** (the catalog schema, JSON). No Markdown layer, no requirement to be readable by other tools. Lessons and projects move between installs as **one bundle file** | component-catalog §2 |
| D6 | Personalisation runs on evidence and is **revisable in both directions**: struggling lowers estimates, and returning after a break discounts for forgetting and re-probes. "How this learner learns" is recorded as **hypotheses with a code-computed trust score**: repeated patterns get stronger, contradicted ones weaker. Every change keeps date, time, model, and session so wrong ones can be undone | data-and-privacy §3.5–3.6 |
| D7 | Motivation through the project story, visible capabilities, informational rewards, connecting lessons to *your* stated reasons, and study plans. Streaks off by default | pedagogy-model §9 |
| D8 | TypeScript + headless Node core + React UI + Electron shell | architecture §4 |
| D9 | **MVP = desktop, offline-first.** The app never needs the internet (only the agent and the user's toolchain might). Mobile comes after the MVP, and the architecture stays cross-platform | architecture §7 |
| D10 | Separate directory per profile. **Encryption is the user's choice** per profile, off by default | data-and-privacy §4–5 |
| D11 | Open source | – |
| D12 | The agent can only use the app-authored component catalog, never raw HTML/JS/CSS | component-catalog |
| D13 | Import sources (papers, PDFs, notes). HMP lesson import comes after the app is proven | teaching-engine §6 |
| D14 | A skill counts as learned only with enough evidence that it **stuck**: still correct a day or more later, and usable in a new situation | pedagogy-model §2.3 |
| D15 | Beginners get more structure by default. The agent can't lower it on its own, and the learner can override it manually | pedagogy-model §3 |
| D16 | **Rich interaction toolkit**: explorables, animations, simulations, drag-to-manipulate, maths input with equivalence checking, sorting/matching, fill-in, sketch answers, run-your-code, quizzes. All authored and tested by the app, and filled with data plus pure maths expressions by the agent | component-catalog §3.3, §3.7 |
| D17 | Everything is tunable, and **every parameter and metric carries a confidence**. Weak evidence can't override strong evidence unless it builds up enough trust | pedagogy-model §14 |
| D18 | Agent **session mode is the user's choice**: per interaction / per lesson (default) / permanent, with guidance based on model strength | architecture §6 |
| D19 | **English only** for the MVP | – |
| D20 | **General learning tool**: nothing is gated on code, but the v1 polish goes to coding projects | teaching-engine §1.1 |

## Decided in round 3 (2026-10-05)

| # | Decision |
|---|---|
| D3 | **Code owns the numbers.** The LLM supplies *structured* observations (evidence events, insight observations); deterministic code (Elo ratings, mastery states, FSRS, trust) turns them into numbers. Implemented in `packages/core/src/learner/` |
| D21 | **License: AGPL-3.0-only.** Free, OSI-approved copyleft: every distributed fork must stay open source under the same terms, including forks offered as a hosted service. `LICENSE` at the repo root |
| D22 | **Working name: Aporia.** It is authored in exactly one place, `packages/brand/brand.json`. Internal packages use the neutral `@app/*` scope, so a rename never touches code. More candidates are in `names.md` |

## Research follow-ups (tracked, not blocking)
- Verify every ○ entry in `learning-science.md` and fill in the missing effect sizes.
- Calibrate the rating step sizes and hint credits on simulated learners.
- Re-check Anthropic's terms for ACP and subscription use before the first public release.
- Pick a maths-equivalence library for `math-input` (candidates: mathjs for numeric
  equivalence; a small CAS for symbolic), during the catalog spike.

## Roadmap and status

The forward-looking plan lives in [`roadmap.md`](roadmap.md). This table records what has been built.

| Step | Status |
|---|---|
| 0. Spikes: ACP + Claude subscription, MCP via ACP, permission routing | **Done** (architecture §8) |
| 1. Core: store, journal, changes + undo/redo, learner engine, profiles | **Done** (`packages/core`) |
| 2. Component catalog v1, validator, expression language, renderers | **Done** (`packages/catalog`, `packages/ui/src/lesson`) |
| 3. Agent host, teaching MCP tools, ask-about-selection, session modes | **Done** (`agent-host`, `teacher-mcp`, `server`, UI) |
| 4. Project creation, interview, curriculum graph | **Done**: interview forms with app-scored probes, `assessment.json`, the profile skill map, project curricula and the Path page |
| 5. Checkpoints (test runner), build ladder, review queue (FSRS UI), difficulty controller in authoring, help-policy enforcement | **Partial**: test runner, ladder and review screen done. Not yet: difficulty controller in authoring, hint-level gate (Phase 2) |
| 6. History / proposed changes UI, Me page, profiles | **Done**. Encryption **not yet** |
| 7. Source import | **Not started** |
| 8. Packaging for 3 OSes, agent eval suite | **Partial**: Electron shell + smoke test. No installers or eval suite yet |
| 9. Post-MVP: Claude Code plugin, HMP lesson import, mobile, languages | Not started |

### Known gaps (next up, in order)
1. **Dogfood Phase 1** on Heavy Metal Physics (the roadmap's exit test), with the real agent.
2. **Hint ladder enforced** and the difficulty controller fed into authoring (roadmap 2.1, 2.2).
3. **Misconceptions** as first-class objects (2.3).
4. **Source import** (PDF/Markdown).
5. Profile **encryption** (opt-in).

## Decision log
- 2026-10-05: D1, D8, D11, D12, D13 (round 1).
- 2026-10-05: D2, D4–D7, D9, D10, D14–D20 (round 2).
- 2026-10-05: D3, D21 (AGPL-3.0), D22 (working name Aporia). Building started (roadmap step 1).
- 2026-10-05: Steps 0–3 and 6 done; the real-Claude spikes passed (architecture §8).
- 2026-10-06: Phase 1 built (roadmap 1.1–1.8) and a first brain view (2.8). Checkpoints run the
  learner's own command, never a shell, and never one the tutor changed. The editor writes the
  workspace only on the learner's explicit save. The skill map is per profile: the tutor describes
  it, code colours it from evidence.
