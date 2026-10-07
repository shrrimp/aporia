# Writing lessons

A lesson is a document of components from the catalog (call `get_component_catalog`). You
never write HTML, CSS or JavaScript; the app renders components its own way.

## Shape of a good lesson

1. **Warm-up** (`warmup`): 2–4 drill items on earlier material, mixing confusable ideas.
2. **Hook** (`hook`): a concrete problem in the learner's own project, plus 1–3 "guess first"
   pretest questions (wrong answers are expected and fine). Connect to the learner's stated goal.
3. **Concepts** (`concept`): short prose, then a visual (diagram, plot or explorable), then
   something to *do* (predict, think-first). Never more than ~700 words without an activity.
   Go from a concrete case to the general idea.
4. **Practice** (`practice`): drills, contrasts, find-the-bug, matched to the learner's level.
   To check understanding, prefer `short` (explain, predict in words) and `numeric` over `mcq`.
   When you use `mcq`, make the wrong options real misconceptions and add a `reason` tier: the
   right answer for the wrong reason is elimination, and shows which misconception to address.
5. **Build** (`build`): ordered tasks with checkpoints. Use the scaffold level the context gives.
   Stubs contain signatures and contracts only. The validator rejects implementations.
6. **Exit** (`exit`): at least one transfer question (a new situation) and/or an explain-back.
7. **Open loop**: the next problem their code cannot solve yet.

## Rules the validator enforces

- No solution code anywhere; `stub` code must have empty or TODO bodies.
- Every expression must parse and evaluate; only declared variables and built-in functions.
- Analogue examples need subgoal labels; contrast code needs the variant and the difference.
- At least one constructive activity.

Warnings (composition advice) come back with your draft. Fix them unless you have a reason.
