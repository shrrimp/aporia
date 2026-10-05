# Pedagogy model: the system derived from the evidence

This turns `learning-science.md` into concrete mechanisms. Each rule cites its evidence ids.
Every number is a **named parameter** with a default, an evidence grade, and a place where the
learner (or a future maintainer) can tune it. Defaults that only have grade C or D evidence are
marked ⚠, meaning "best guess, watch it".

Ownership notation: ⚙ = deterministic code, 🧠 = LLM, 👤 = learner.

---

## 1. Core objects

| Object | What it is | Owner |
|---|---|---|
| **KC** (knowledge component) | One unit of skill or knowledge: `quaternion.exp-map-side` | 🧠 proposes, ⚙ validates |
| **Edge** | `prereq` (A before B) or `confusable` (A and B get mixed up, used for interleaving per R6) | 🧠 proposes, ⚙ validates (acyclic for prereq) |
| **Item** | An assessable unit tied to KCs: a drill question, a checkpoint step, an explain-back, a trace task | 🧠 authors, ⚙ validates |
| **Activity** | An instance of a component from the catalog (`component-catalog.md`) with an **ICAP mode** (G1) | 🧠 authors |
| **Evidence** | An event: item × outcome × context (hints used, confidence, delay since instruction) | ⚙ records |
| **Lesson / Task** | Composed activities, see `teaching-engine.md` | 🧠 authors, ⚙ validates the composition rules in §4 |

## 2. Learner state

### 2.1 Per-KC ability (replaces BKT, per T3)
Each KC has an ability `θ` (logit scale) and an uncertainty count `n`. Each item has a
difficulty `b` (prior set by 🧠 at authoring on a 1–5 scale and mapped to logits by ⚙).

```
P(success) = sigmoid(θ_kc − b_item)
θ_kc ← θ_kc + K(n) · w_evidence · (outcome − P)       outcome ∈ [0, 1] (partial credit)
K(n)  = K0 / (1 + a · n)                               # uncertainty-weighted Elo (Pelánek 2016)
```

When an item touches several KCs, the update is split across them, weighted by the author's
tags. This is ⚙ only, fully unit-tested, and replayable from the event log.

### 2.2 Evidence weights and hint-adjusted credit

| Evidence | `w` | Outcome rule | Rationale |
|---|---|---|---|
| Interview probe | 0.8 | 🧠-judged 0–5 → [0,1] | W2 rapid diagnosis |
| Checkpoint step (tests) | 1.0 | pass = 1, else fraction of the step's tests | Objective, step-level (T1) |
| Recall / production drill, `math-input`, `fill-in`, `sketch-answer` | 1.0 | exact or ⚙-checkable (equivalence / tolerance) | R1 |
| Prediction (before a reveal) | 0.7 | correct / incorrect | G3 |
| Recognition (multiple choice) | 0.5 | correct / incorrect | Weaker than production (R1, R2) |
| Explain-back | 0.6 × agreement | 🧠 rubric 0–5, scored **twice**; if the two scores differ by >1, a third; agreement = 1 − spread/5 | AI8 |
| Self-rating | 0.2, prior only | – | M2 |

**Hint-adjusted credit (W4, AI1):** `outcome × c(hint_level)` with
`c = [1.0, 1.0, 0.8, 0.6, 0.4, 0.2]` for levels L0–L5 ⚠. Using help is never punished in the
UI; it just counts as weaker evidence.

### 2.3 Mastery states (R7, R3, T2)
In plain words: **a skill counts as learned only when there's enough evidence that it
stuck**. You got it right, you can still do it a day or more later, and you can use it in a
situation you haven't seen before. Doing well once, right after the explanation, is not
enough (R7).

```
unseen → introduced → practising → mastered (provisional) → mastered (durable)
                ↑                                                  │
                └──────────── failed delayed retrieval ◄───────────┘
```
- **provisional:** `P(success on a b = 3 item) ≥ τ_mastery` (default **0.85** ⚠, T5).
- **durable** also needs: ≥ 2 *different* evidence types, **and** ≥ 1 successful retrieval at
  least `Δ_delay` (default **1 day**, R3/R7) after the last instruction on that KC, **and** ≥ 1
  successful *transfer* item (R2).
- Only **durable** mastery unlocks dependants at full independence. Provisional mastery
  unlocks them *with* extra scaffolding (§3). This keeps people moving without pretending.

### 2.4 Memory (R3, R4)
Each retrievable item has FSRS state. Desired retention defaults to **0.90**. A failed review
lowers the KC's θ through normal evidence and can demote durable → provisional.

### 2.5 Global learner signals (⚙ derived)
| Signal | Definition | Used by |
|---|---|---|
| `success_rate` | First-attempt success over the last `N = 12` items | §5 difficulty control |
| `calibration` | Brier score of confidence vs correctness | §8, shown on the Me page (T4) |
| `hint_dependence` | Mean hint level on tasks over the last 10 tasks | §6, the Me page |
| `interest_phase` | 1–4 (MO6), estimated from voluntary actions (optional quests, extra explorables, self-started reviews) | §9 |
| `misconceptions[]` | See data-and-privacy §3.3 | §3, §7 |

## 3. Instructional policy: picking the activity sequence

⚙ picks the **form** of instruction per KC from its state. 🧠 writes the **content** in that
form.

| KC state | Goal type | Programming? | Sequence | Evidence |
|---|---|---|---|---|
| unseen, prereqs weak | any | – | Fix the prerequisite first (micro-lesson or review) | W6, T2 |
| unseen / introduced, θ low | procedural | yes | Worked example **with subgoal labels** → trace / predict-output → Parsons → completion stub → write | W1, C3, C1, C2, W3 |
| unseen / introduced, θ low | procedural | no | Worked example → faded example → problem | W1, W3 |
| unseen, θ of prereqs high | conceptual | any | **Problem first** (PS-I: open problem, several attempts invited) → consolidation built on the learner's attempts | W5 |
| unseen, otherwise | conceptual | any | Pretest question → concrete case → concept + visual → predict/observe → explain-back | R5, P3, P2, G3, G2 |
| practising | any | – | Completion/contract-level tasks, contrast cases, then **erroneous examples** | W2, G4, G5 |
| provisional mastery | any | – | Goal-level tasks, transfer items, interleaved review with confusable KCs | W2, R2, R6 |
| durable | any | – | Only spaced review, plus use inside bigger tasks | R3 |
| active misconception | any | – | Confront: prediction that the misconception gets wrong → observe → contrast → explain-back | M3, G3, G4 |

**Self-explanation prompts:** at most **one per concept section**, always about the *concept*
("why must momentum use the force rule?"), never "explain your plan" (G2, W1).

**Novices get more structure, not less (AI2):** while `θ` is low, task scaffolding
**defaults** to no lower than *completion* level. The agent can't lower it on its own. The
learner can, with a manual override (§14), and the UI explains the trade-off once (MO1).

## 4. Lesson composition rules (enforced by the ⚙ validator)

A lesson draft is **rejected** (and the reason returned to 🧠) unless:

| Rule | Default | Evidence |
|---|---|---|
| Estimated time in Constructive + Interactive activities | ≥ **50%** ⚠ | G1 |
| Longest passive run (reading/watching without an activity) | ≤ **~700 words** or 1 figure group ⚠ | P2 segmenting |
| Every new concept has a visual component (figure, diagram, plot, layout) | required | P2 |
| Warm-up | 2–4 items from due reviews and confusable KCs | R1, R3, R6 |
| Pretest ("guess first") on the lesson's new KCs | 1–3 items, wrong answers framed as expected | R5 |
| Exit check | ≥ 1 transfer item + ≥ 1 production item | R2, R1 |
| Utility link | 1 line connecting to the learner's stated goal + optional prompt for the learner to write their own connection | MO5 |
| Open loop | required | MO8 |
| No solution content | stub check, no `solution` component exists | AI1, AI2 |
| Scaffold level per task | must match the level ⚙ chose (±1 if the learner asked) | W2 |

## 5. Difficulty control (T5, W4)

- Target first-attempt success band **[0.70, 0.85]** ⚠.
- When `success_rate > 0.85` over N items: next tasks drop one scaffold level, or use items
  with `b + 1`. When `< 0.70`: the reverse. Hysteresis: no change for 4 items after an
  adjustment.
- The band is shown on the Me page, and the learner can move it ("I want it harder"),
  which counts as autonomy (MO1).

## 6. Help policy (hint ladder)

| Rule | Definition | Evidence |
|---|---|---|
| **H1** Levels | L0 reflect → L1 point → L2 Socratic question → L3 analogous worked example → L4 partial structure of *their* code with the key part blank → L5 principle stated plainly. **No level writes the solution.** | W4, AI1, AI6 |
| **H2** Attempt gating | L4+ needs an attempt (code change or written attempt) since the previous hint | W4, B6* |
| **H3** Per-learner start level | A conceptual question on a KC with low θ starts at L1, not L0. Answering "what have you tried?" when they're lost wastes effort | AI2, W2 |
| **H4** Stuck detection | `T_stuck` = **15 min** of active time without progress (no new passing test, no edit that changes the failing set) **or** 3 runs with the same failures → the tutor offers help once (L0/L1). It never jumps in uninvited earlier | M3 ⚠ |
| **H5** Free explanation | Questions about *concepts* (not the current task's answer) are answered fully, with visuals and resources. Explaining is the tutor's job | G1, AI3 |
| **H6** Factual self-check | Hints at L3+ and all authored maths are checked: maths/code claims by a ⚙-run check where one exists (the test suite, an explorable computation); otherwise a second 🧠 sample checks the claim. A disagreement shows "unverified" to the learner | AI5 |

*B6 = help-seeking/gaming research (Aleven et al. 2006; Baker et al. 2004), cited from memory.

## 7. Review and retrieval

- FSRS schedules every retrievable item (R4). Warm-ups pull due items first, then items from
  `confusable` KCs to interleave (R6).
- Item types for review, in preference order: **apply/infer** > produce > predict > recognise
  (R2). Review never re-shows a lesson's text as the review activity (R1: rereading is low
  utility).
- Daily review cap: **20 items or 15 minutes** ⚠, whichever comes first. Over the cap, items
  are ranked by memory risk × KC importance (number of dependants).
- High-confidence errors are rescheduled sooner (F2).

## 8. Feedback and metacognition

- Feedback is task- and process-level and specific: *which invariant, which line, which
  concept*. Never just "wrong", never generic praise (F1, MO2).
- Optional confidence rating on drills and predictions (3 levels). It feeds `calibration` and
  F2.
- An **open learner model** on the Me page shows θ as plain-language bands, evidence links,
  misconceptions, calibration, and hint dependence (T4).
- Effort framing: the first time a learner meets a pretest, an interleaved review, or a
  problem-first task, a one-time note explains why it feels harder and why that is intended
  (M1).
- End-of-lesson reflection is **one line, optional**, and concept-focused ("what was the key
  idea?" rather than "how did you feel about your planning?") (G2).

## 9. Motivation policy

| Mechanism | Rule | Evidence |
|---|---|---|
| Project narrative | Each lesson states the *capability* it unlocks in the learner's project. The path shows capabilities, not points | MO3 |
| Utility value | At project start, the learner writes why the project matters to them. Every ~3 lessons, an optional prompt asks them to connect the current topic to that "why" | MO5 |
| Interest phases | Phases 1–2: more hooks, explorables, short wins, structure. Phases 3–4: more autonomy, open problems, optional deep dives, design reviews | MO6 |
| Session planning | Weekly plan with **if-then** cues set by the learner; the app reminds only at the times the learner chose | MO7 |
| Rewards | Informational only: mastery reached, capability unlocked, a specific achievement ("found the bug by checking an invariant"). No points for time or completion | MO2 |
| Streaks | **Off by default.** Opt-in, counting weekly plan adherence (not daily use), with freezes | MO4 |
| Autonomy | The learner can reorder lessons (within prerequisites), choose optional quests, move the difficulty band, and request scaffold ±1 | MO1 |

## 10. The interview as an adaptive diagnostic

- Goal: reduce uncertainty on the top-level KC clusters needed for the project, and **find
  misconceptions**, not just levels (W6).
- Method: **first-step probes** (W2, Kalyuga's rapid assessment), e.g. "what's the first line
  you'd write?" or "which rule applies here?", then binary-search the difficulty: correct →
  harder, wrong → easier.
- Stop rule: every required cluster has ≥ 2 probes **or** the time budget is reached (default
  20 min ⚠). The rest is learned from lessons, so the interview never tries to be complete.
- Self-ratings are collected but only set *priors* (w = 0.2).
- **Re-probing:** the same diagnostic runs as a short "welcome back" check when a project is
  reopened after a long gap (KC retrievability below 0.7), and whenever evidence contradicts
  the interview (data-and-privacy §3.5).

## 11. Imported material (your uni papers, PDFs, notes)

- Imported sources are **inputs to teaching, not things to reread** (R1: rereading is low
  utility).
- 🧠 maps a source to KCs. Lessons and review items cite source passages (page/section
  anchors), so the learner can always see where an idea comes from.
- The default "study this source" flow is pretest → short section → retrieval/explain → next
  section → spaced review of the source's KCs. That is R5 + R1 + G2 + R3 applied to someone
  else's material.
- Exam-prep mode (optional): build the review set from the source's KCs with a target date.
  The scheduler sets the desired retention for that date (Cepeda gap ratios, R3).

## 12. Who does what

| Mechanism | ⚙ code | 🧠 LLM |
|---|---|---|
| KC graph | Validate, store, cross-project linking | Propose KCs and edges |
| Ability, mastery, memory | All of it | – |
| Choosing the instructional form (§3) | All of it | – |
| Writing lesson content | Validate composition (§4), stub check, schema | Write it |
| Scoring items | Exact and checkable items, tests | Free-form answers (rubric, double-scored) |
| Hints | Level, gating, stuck detection, logging | Write the hint |
| Factual checks | Run tests and computations | Second-sample check where ⚙ can't |
| Review scheduling | All of it (FSRS) | Write review items once, at authoring |
| Motivation | Capability path, plans, reminders, streak rules | Narrative text, utility prompts |

## 13. How a learner (and we) know it works

Personal analytics on the Me page, computed locally:
- **Delayed retrieval success** (reviews ≥ 1 week after instruction): the best single signal
  of durable learning (R7).
- **Transfer item success** (R2).
- **First-attempt checkpoint rate** and its trend.
- **Calibration** trend.
- **Hint dependence** trend (should fall per KC over time).

These same metrics, run on scripted learners, form part of the evaluation suite
(`quality.md` §4).

## 14. Parameters and confidence

Every parameter and every learner metric carries a **confidence**, so weakly supported ideas
can never outweigh well-established research.

- **Research defaults** get confidence from their evidence grade: A = 0.9, B = 0.75, C = 0.6,
  D = 0.4.
- **Learner-specific values** (insights, tuned parameters, θ itself) get confidence from their
  evidence: insight trust (data-and-privacy §3.6), and θ certainty from the evidence count
  `n`.
- **Precedence rule:** when a learner-specific value conflicts with a research default, the
  one with higher confidence wins, and the losing one is still shown to the agent as context.
  Example: a one-off "prefers to be told the goal only" (trust 0.67) does not override the
  novice scaffolding floor (D15, grade B → 0.75). Seen consistently (trust 0.85), it does.
- **Manual overrides** by the learner always win (autonomy, MO1), shown with a note when they
  go against strong evidence.
- Every metric on the Me page displays its confidence.

### Parameter table

| Parameter | Default | Grade → confidence | Source |
|---|---|---|---|
| `K0`, `a` (Elo step) | 0.4, 0.05 ⚠ | C → 0.6 | T3 (to calibrate on simulated learners) |
| `τ_mastery` | 0.85 | C → 0.6 | T5 |
| `Δ_delay` for durable | 1 day | B → 0.75 | R3, R7 |
| FSRS desired retention | 0.90 | B → 0.75 | R4 |
| Target success band | 0.70–0.85 | C → 0.6 | T5 |
| `N` success window | 12 | D → 0.4 | – |
| Hint credit `c` | 1, 1, .8, .6, .4, .2 | D → 0.4 | W4 |
| `T_stuck` | 15 min active / 3 identical runs | D → 0.4 | M3 |
| C+I time share | ≥ 50% | C → 0.6 | G1 |
| Max passive run | ~700 words | D → 0.4 | P2 |
| Review cap | 20 items / 15 min | D → 0.4 | – |
| Interview budget | 20 min | D → 0.4 | W2 |
| Explain-back weight | 0.6 × agreement | C → 0.6 | AI8 |
