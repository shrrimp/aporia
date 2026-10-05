# Component catalog: the only thing the agent can display

**Decision (yours, Q4):** the agent never writes HTML, CSS, or JavaScript. The app defines a
fixed catalog of **semantic components**, and the agent fills them with data through MCP tools.
How a component looks is decided entirely by the app's renderers, and the agent is never told.
That gives us:

- **Safety:** no agent-authored code runs in the UI, so there is nothing to sandbox and no XSS.
- **Model-agnosticism:** a small model filling a schema produces valid, good-looking output. A
  small model writing free HTML doesn't.
- **Consistency:** every lesson looks like the app, on every device, in both themes.
- **Separation:** renderers can be redesigned, or rewritten (desktop, mobile, print, screen
  reader), without touching any lesson.

## 1. Principles

1. **Semantic, not visual.** Components say *what* something is (`callout.kind = "trap"`,
   `emphasis = "incorrect"`), never how it looks (no colours, sizes, or positions in pixels).
2. **Schema-validated.** Every component has a JSON Schema. Invalid → rejected with an error
   message written for the agent to fix.
3. **Accessible by construction.** Every visual component *requires* a text `description`.
   Interactive ones require labels. The validator enforces both.
4. **ICAP-tagged.** Each component type has a default engagement mode (P/A/C/I) used by the
   composition rules (`pedagogy-model.md` §4).
5. **Versioned.** The catalog has a version. Lessons record the version they were written
   against, and migrations upgrade old lessons.

## 2. Storage format: the lesson *is* the component document

There's no separate "display format". A lesson is stored **exactly as the agent wrote it**:
the component tree, in the catalog's own schema (JSON, with a `catalogVersion`). What the
agent draws is what is saved, and what is saved is what renders. Diagrams, 3D views, maths,
explorables, quizzes, and tasks all live in that tree.

- **Lesson file:** `lesson.json` (component tree) + an `assets/` folder for anything binary
  (e.g. images from imported sources).
- **Transfer:** a lesson or a whole project exports as a single **app bundle file** (extension TBD
  with the name, a zip of the folder with a manifest and checksums) that another install
  of the app can import. It doesn't need to be readable by other tools.
- **Hand-editing** isn't a goal. Edits happen through the app (or by the agent) and go through
  the same validation and history.
- Prose fields inside components use a minimal text format (CommonMark subset + TeX maths +
  inline code). **Raw HTML is rejected.**

## 3. The catalog (v1 draft)

### 3.1 Reading (P)
| Component | Purpose | Key fields |
|---|---|---|
| `prose` | Text with maths and inline code | `md` |
| `math` | Display equation, optionally tagged | `tex`, `tag?` |
| `callout` | Aside | `kind: note \| trap \| key-idea \| history \| aside`, `md` |
| `code` | Code display, by **kind** (see 3.4) | `lang`, `kind`, `source`, `annotations[]` (line → note) |
| `table` | Data table | `columns[]`, `rows[]`, `caption` |
| `source-ref` | Quote and link to an imported source (pdf page, section) | `source_id`, `anchor`, `excerpt` |
| `resource` | External reading/video, with why it's worth it | `title`, `url`, `why`, `time_min` |

### 3.2 Visual (P → A when interactive)
| Component | Purpose | Key fields |
|---|---|---|
| `diagram2d` / `diagram3d` | Declarative scene: points, vectors, frames, segments, arcs, polygons, curves, labels, in a coordinate system | `elements[]` with `role` (primary/secondary/annotation), `emphasis`, `description` |
| `plot` | Function or dataset plot | `series[]` (expression or data), `axes`, `description` |
| `graph` | Tree/DAG/state graph with highlights (kinematic trees, KC maps, call graphs) | `nodes[]`, `edges[]`, `highlight[]` |
| `memory-layout` | Arrays, structs, windows/offsets into them (the q/v windows builder) | `buffers[]`, `regions[]`, `interactive?` |
| `stepper` | Step through precomputed **states** of an algorithm; each state renders one of the visual components above | `states[]`, `labels[]` |

### 3.3 Explorables (A): interactive without agent code
| Component | Purpose |
|---|---|
| `explorable` | Controls + a **pure expression model** + bindings to visual components |

```jsonc
{
  "type": "explorable",
  "description": "Nudge a quaternion three ways; one keeps it a rotation",
  "state":    { "q": "quat_axis_angle([1,-2,0.5], deg(50))" },
  "controls": [
    { "kind": "button", "label": "x += 0.15",              "do": "q = q + quat(0, 0.15, 0, 0)", "emphasis": "incorrect" },
    { "kind": "button", "label": "q ⊗ exp(ω dt) ×10",      "do": "q = iterate(10, s -> s * qexp([0,1.5,0] * 0.05), q)", "emphasis": "correct" },
    { "kind": "button", "label": "normalize",              "do": "q = normalize(q)" },
    { "kind": "reset" }
  ],
  "readouts": [ { "label": "|q|", "expr": "norm(q)", "format": "0.000000" } ],
  "view": { "type": "diagram3d", "elements": [
      { "kind": "box", "transform": "mat3(q)", "role": "primary" },
      { "kind": "box", "transform": "mat3(normalize(q))", "role": "ghost" } ] }
}
```

The **expression language** is the only "logic" the agent can write:
- Pure, deterministic, no I/O, no strings beyond labels, no user-defined recursion.
- Types: scalar, vector, matrix, quaternion, complex, bool, list.
- Built-ins: arithmetic, trig, `dot`, `cross`, `norm`, `normalize`, `mat3`, `quat`, `qexp`,
  `qlog`, `inverse`, `transpose`, `solve` (small dense), `iterate(n, f, x0)` with `n ≤ 10⁴`,
  `map`, `range`, `sum`, `clamp`, `lerp`.
- A step budget per evaluation (e.g. 10⁶ ops), so bad expressions fail cleanly.
- Interpreted by the core's own evaluator (not `eval`), fuzzed and property-tested.

This covers every widget in the HMP artifacts reviewed so far (quaternion nudge, left vs right
multiply, layout builder, energy drift plots). Anything that needs *real computation* (e.g. running
the learner's solver) goes through `stepper` or `plot` with **data** the agent got from the
test runner or from running code in its own sandbox. It is never code executed in the UI.

### 3.4 Code kinds (no `solution` kind exists)
| `kind` | Allowed | Validator check |
|---|---|---|
| `stub` | Signature + contract comments, empty/`TODO` body | Body has no statements beyond `TODO`/throw/default return |
| `api` | How to *use* an existing API, example shaped differently from the task | Similarity check vs open tasks' expected shape |
| `layout` | Struct/array definitions illustrating data layout | – |
| `analogue` | Worked example of an *analogous* problem, with **subgoal labels** (C3) | Similarity check; `subgoals[]` required |
| `trace` | The **learner's own** code, annotated | Must reference a workspace file + line range |
| `contrast` | Two snippets differing in one feature | Exactly 2 variants, with `difference` text |
| `buggy` | Erroneous example for find-the-bug | Bug metadata stored server-side, not shown |

### 3.5 Activities (C / I)
| Component | ICAP | Purpose | Scored by |
|---|---|---|---|
| `pretest` | C | "Guess first" on untaught content (R5) | ⚙ |
| `predict` | C | Commit a prediction, then reveal a visual or explanation (G3) | ⚙ |
| `think-first` | C | Prompt → learner writes → reveal (G2) | 🧠 optional |
| `drill` | A/C | `mcq`, `numeric`, `short`, `order` (Parsons), `match`, with optional confidence | ⚙ (🧠 for `short`) |
| `trace-task` | C | Fill in the values of variables or state per step (C1) | ⚙ |
| `find-the-bug` | C | Locate and explain the bug in a `buggy` snippet (G5) | ⚙ location, 🧠 explanation |
| `contrast-task` | C | Pick the right variant and say why (G4) | ⚙ + 🧠 |
| `explain-back` | C→I | Explain in your own words, then dialogue (G2, AI8) | 🧠 double-scored |
| `task` | C | A build step in the learner's workspace: contract, files, scaffold level, traps, checkpoint | ⚙ tests |
| `checkpoint` | – | Staged test suite + expected pass count | ⚙ |
| `reflection` | C | One line, concept-focused, optional | – |
| `utility-link` | C | Connect to the learner's goal; optional writing prompt (MO5) | – |
| `open-loop` | – | The next unsolved problem (MO8) | – |

### 3.6 Structure
`lesson` → `section[]` → components. Section `role`: `warmup | hook | concept | practice |
build | exit | open-loop`. The composition rules in `pedagogy-model.md` §4 are checked on this
tree.

### 3.7 Interaction toolkit (motion, simulation, direct manipulation)

Interaction must go well beyond "write code and ask questions": anything that helps learning
should be available, as long as the app authors and tests it. Built on the same expression
language as `explorable`:

| Component | What the learner can do | Example |
|---|---|---|
| `animation` | Play / pause / scrub a timeline. Keyframes or expressions of `t` drive any visual | A frame rotating as ω integrates; RNEA's outward then inward pass |
| `simulation` | Run a stepped system: state + update rule (expressions) + integrator choice + controls | Pendulum with explicit vs symplectic Euler; energy readout drifting or not |
| `manipulate` | **Drag** points, vectors, frames, or sliders in a diagram, with constraints; the bound state updates live | Drag a body's offset and watch `p × ℓ` change the angular momentum |
| `math-input` | Type a formula. The app checks it by **symbolic/numeric equivalence**, not string match | "Write the force transform for the moment" |
| `drag-sort` / `match` / `categorise` | Order steps (Parsons), match pairs, sort items into bins | Sort quantities into motion vs force types |
| `fill-in` | Fill blanks in a formula, table, or trace | Fill the RNEA table for a 2-link chain |
| `sketch-answer` | Place or draw a vector/point/region on a diagram as an answer, checked against a tolerance | "Draw the direction of the reaction force" |
| `code-run` (**coding projects**) | Run a small snippet or the learner's function against inputs **in the learner's own toolchain** via the core's test runner, then see outputs or plots | Run `integratePosition` 100 steps and plot \|q\| |
| `quiz` | A scored set of any of the activity components, with optional confidence | Exit check |

**Rules:** every component is pure data plus expressions. Nothing the agent writes executes
outside the evaluator (or, for `code-run`, outside the learner's normal test command run by
the core). Each new component type ships with renderer tests, schema fuzzing, accessibility
checks, and an agent-facing doc with examples. The catalog grows **by app releases**, driven
by what lessons turn out to need.

## 4. What the agent sees## 5. Open points
- Whether `explorable` expressions are enough for later domains (fluids, signals, statistics).
  New built-ins are cheap to add, but each one ships with the app, never with a lesson.
- Audio/video components (e.g. for language learning) are deferred.
