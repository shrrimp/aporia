# UX

Goals: calm, fast, focused on the work. The chat is a *side tool*, not the centre. It runs on
desktop and touch alike.

## 1. Screens

1. **Profile picker**: avatars, a lock icon for encrypted profiles, and "New profile".
2. **Home**: projects as cards, each with a one-line "next up", a progress ring, and due
   reviews. A "Review (6 due)" button. A "Start a new project" card.
3. **New project**: the guided goal-capture screen (teaching-engine §1.1), then the interview
   as a focused conversational view with the draft KC graph filling in alongside it.
4. **Project map**: the curriculum graph as a *path* (like the lesson-ladder visual in your
   artifacts): mastered / in progress / available / locked, with tooltips explaining *why*
   something is locked ("needs: spatial dual transforms").
5. **Workspace** (main screen): see §2.
6. **Review**: spaced review session.
7. **Me**: the learner model shown as a readable page: strengths, working-on, misconceptions
   (with evidence), preferences (stated vs observed), teaching insights with their trust
   scores, and confidence levels on every metric. Editable. This is an *open learner model*. Showing the model is itself good for
   metacognition (T4).
8. **History & proposed changes**: every change the agent made or proposed (lessons, learner
   data, curriculum, insights) with time, model, session, reason, and evidence. Accept /
   reject (review mode), **Undo / Redo buttons** on every change, and bulk revert by filter.
   No keyboard shortcut undoes agent changes, so typing can never trigger it
   (data-and-privacy §3.4). A badge in the top bar shows pending proposals.
9. **Settings**: agent selection (detected ACP agents), session mode (per interaction / per
   lesson / permanent, data-and-privacy and architecture §6), review vs auto-apply mode,
   encryption, profile export/import, context inspector.

## 2. Workspace layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ◂ HMP   Lesson 09 · Four Numbers, Three Speeds        ▮▮▮▮▮▯▯ step 4/7   ⚙  │
├───────────────────────────────┬──────────────────────────────────────────────┤
│ LESSON                        │ EDITOR  (Monaco)  Joint.cpp  Model.cpp  +    │
│                               │                                              │
│ 03 The two new joints …       │  void integratePosition(...) {               │
│ [prose, maths, explorable]        │      // your code                            │
│                               │  }                                           │
│ ┌ Task · Step 4 ───────────┐  │                                              │
│ │ integratePosition         │  │                                              │
│ │ contract · traps · ▶ Run │  ├──────────────────────────────────────────────┤
│ │ checkpoint 119/148 ✓      │  │ TERMINAL / TEST OUTPUT                       │
│ └───────────────────────────┘  │ MultiDof: 52/66 …                           │
├───────────────────────────────┴──────────────────────────────────────────────┤
│ 💬 Ask  ·  hint level 1/5  ·  "why does the right side…"            ⌘K      │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Three panes, all resizable and collapsible**: lesson | editor (+ terminal) | ask drawer.
  The ask drawer is a thin bar by default and expands on demand (your "chat should be minor").
- **External editor mode**: hide the editor pane. The core watches the workspace, and
  checkpoints and the agent see your changes from VS Code, Neovim, or anything else.
- **Focus mode**: the lesson + task only, everything else hidden.
- **Narrow windows**: panes stack into tabs (Lesson / Editor / Ask). This also keeps the UI
  ready for a mobile client after the MVP.

## 3. "Ask about this"

- Select any text, maths, code (in lesson *or* editor), or explorable state → a floating
  **Ask** chip appears (plus a keyboard shortcut).
- Quick intents on the chip: *Explain differently* · *Why?* · *Show me a picture* ·
  *Give me an example (not the answer)* · *I think this is wrong* · free text.
- The question is **anchored**: it shows as a margin marker on the lesson, and the
  thread stays attached to that paragraph (like comments). Later readers (you, next week)
  see "you asked about this; here's what helped".
- If the agent revises the lesson in response, the change appears as an inline diff:
  **Keep** / **Revert**.
- The free-input box is always available for anything else.

## 4. Running checkpoints

- ▶ **Run** on a task runs that task's staged tests and shows the result in a ladder:
  "119 / 148 · this step expects ~119 ✓".
- Failures are grouped by invariant, with a link to the relevant lesson section, never with
  the fix.
- Hitting a checkpoint gives a quiet, satisfying confirmation (subtle animation, path node
  fills). No confetti spam.

## 5. Visual language

- Taking cues from your lesson artifacts: serif body text for reading, a clean sans for UI,
  a mono for code, restrained colour with meaning (one accent; green = verified; red =
  violated invariant), both light and dark themes.
- Maths in KaTeX, figures as SVG that follow the theme.
- Accessibility: keyboard-first, reduced-motion support, WCAG AA contrast, screen-reader
  labels on every visual and interactive component (enforced by the catalog schema) (the existing lessons already have `aria-label`s).

## 6. Motivation design ("fall in love with the process")

Grounded in `learning-science.md` (MO*) and `pedagogy-model.md` §9. What we **do**:

| Mechanic | Why | Detail |
|---|---|---|
| **The project is the story** | Narrative elements were among the strongest moderators (MO3) | Each lesson unlocks a *visible capability* in the learner's own project ("your chain now has ball joints"), shown on the path. Optional: a short clip or screenshot of the viewer per milestone. |
| **Mastery path** | Competence (MO1) | The project map fills in as KCs reach mastery *by evidence*. |
| **Checkpoint ladder** | Clear goals and immediate feedback, the conditions for flow (T1) | 41 → 52 → 119 → … per step. Already proven in your lessons. |
| **Open loop endings** | Curiosity gap (MO8) | Each lesson ends on the next unsolved problem. |
| **"Aha" journal** | Reflection, ownership | One-line reflections collected into a personal log of insights you can scroll back through. |
| **Quests (optional)** | Autonomy (MO1) | Side challenges offered by the agent: "make it reversible", "prove energy is conserved". Never required. |
| **Specific praise** | Informational feedback (F1, MO2) | "You found that by checking the invariant first", never "great job!". |
| **Calibration badge** | Metacognition (F2, M2) | Shows how well your confidence matches your accuracy, a skill worth gaining in itself. |
| **Weekly rhythm** | Habit without guilt | Shows a "you studied 3 of your 4 planned sessions" goal (set by the learner), with no punishment for missing it. |

What we **don't** do: loss-framed streaks, XP for time spent, leaderboards (single-user anyway),
variable-ratio random rewards, push notifications that guilt the user, artificial scarcity.

Streaks are **off by default**. They can be enabled as an opt-in that counts *weekly plan
adherence* (not daily use), with freeze days (pedagogy-model §9, evidence MO4).
