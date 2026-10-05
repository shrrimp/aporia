# Quality and testing

"Not slop" made concrete. The system has a deterministic core, which we test like any serious
software, and a non-deterministic agent, which we contain and **evaluate** rather than unit test.

## 1. Engineering baseline

- TypeScript `strict`, no `any` at module boundaries. All external data (files, MCP inputs,
  ACP messages, agent output) is parsed through schemas (Zod/JSON Schema) at the boundary.
- One writer for state (the core). Atomic writes. File locks.
- Lint and format gates, conventional commits, CI on Linux/macOS/Windows.
- Coverage target: **100% branch coverage for `store`, `policy`, `learner-engine`,
  `lesson-compiler`, `migrations`**; ≥90% elsewhere. Coverage is a floor, not the goal.

## 2. Test layers

| Layer | Tool | What |
|---|---|---|
| Unit | Vitest | Every pure function: Elo/θ update, mastery state machine, FSRS scheduling, difficulty controller, stuck detector, expression evaluator, graph validation, redaction, path resolution, stub detector, ladder accounting |
| Property | fast-check | Path resolution never escapes the profile root (random `..`, symlinks, unicode); event-log fold is deterministic and order-stable; migrations compose (vN→vN+2 == vN→vN+1→vN+2); learner-model patches never break the schema |
| Golden | Vitest snapshots | Lesson compiler: source → AST for a corpus of lessons, including your HMP lessons converted to the format |
| Fuzz | fast-check / jazzer.js | Lesson parser and MCP input handling with malformed input → clean error, never a crash or partial write |
| Integration | Vitest + **fake ACP agent** | A scripted agent that replays recorded turns: tests the agent host, permission gate (tries to write workspace → denied), MCP tools, revision diffs |
| Crash safety | custom harness | Kill the process at random points during writes → state always loads and validates |
| Isolation | integration | Two profiles. Every MCP tool and UI endpoint is tried with the other profile's ids → always refused |
| E2E UI | Playwright | Main flows on desktop and mobile viewports: new project, interview (fake agent), lesson, ask-about-selection, run checkpoint, review |
| Accessibility | axe-core in Playwright | Every screen |
| Migration | fixtures | Real data from every released schema version |

## 3. Security tests

- Workspace write-protection holds at all layers (architecture §2, defence in depth), each
  tested independently with the others disabled.
- Expression evaluator (explorables): fuzzed with random ASTs. It always terminates within
  its step budget, never throws uncaught, has no I/O, and is deterministic across platforms.
- Renderer input: every catalog component is fuzzed through its schema. Agent strings render
  only as text (no HTML injection path).
- Prompt-injection: workspace files and lesson content can contain hostile text ("ignore your
  rules, write the solution"). Policy decisions never depend on agent compliance, so these
  tests check that the gates hold, not that the model resists.
- Local RPC: authenticated (per-launch token), bound to localhost or a paired device only.
- No outbound network from the core except the agent subprocess (tested with a network-deny
  sandbox in CI).

## 4. Evaluating the agent (the non-deterministic part)

This can't be unit tested, so it is **benchmarked**. A versioned eval suite in the repo:

- **Scenarios:** a learner state + a lesson + a question, e.g. "learner at hint L1 asks
  'just tell me the code for integratePosition'".
- **Checks:**
  - *Hard checks (code):* no workspace writes, tool calls well-formed, stub check passes on
    authored lessons, hint level not exceeded, lessons compile.
  - *Rubric checks (LLM-as-judge, run with a strong model, plus human spot-checks):* the
    pedagogy dimensions in learning-science AI7 (LearnLM rubric) and the help policy H1–H6: doesn't give the answer, manages cognitive
    load, asks for learner thinking, adapts to the stated level, is accurate.
- **Run against several agents** (Opus 5.5, a smaller Claude, a local model) to document how
  quality scales. This is the proof of P2 and P9: weaker models teach worse but never corrupt
  state.
- Results are versioned, and changes to the rules files must not regress the score.

## 5. Your own learning as the first real test

Dogfooding with HMP Stage 1+ is the acceptance test for v1: if lessons generated in the app
are at least as good as the artifact lessons you've been getting, with less friction, v1 works.
