# Learning science evidence base

This is the research the teaching system is derived from. `pedagogy-model.md` turns it into
concrete mechanisms and parameters. Every rule there points back to an entry here by its id
(e.g. `R1`).

In the product, each entry becomes one read-only file in `system/research/`. The agent can
search and cite them (`search_research`), and the learner can read them.

## How to read this

**Evidence grade** for each entry:

| Grade | Meaning |
|---|---|
| **A** | Meta-analysis or multiple large RCTs, replicated across domains |
| **B** | Several controlled studies or one strong RCT, some limits on generality |
| **C** | Theory with supporting studies, or results from a narrower domain we extrapolate from |
| **D** | Design heuristic, practitioner consensus, or a contested result. Used only where nothing better exists |

**Verification:** ✔ = checked against the source or its abstract/index entry during this
research (October 2026), with a link. ○ = classic reference cited from memory. Each ○ entry
must be checked before the research files ship; that is tracked in `decisions.md`.

Effect sizes are Hedges' *g* or Cohen's *d* (≈0.2 small, ≈0.5 medium, ≈0.8 large). Education
effect sizes are often lower in the field than in the lab, so we treat them as *ranking*
evidence rather than as promises.

---

## R. Retrieval and memory

**R1. Retrieval practice (testing effect). Grade A ✔**
Practice tests beat restudy (g = 0.51) and no activity (g = 0.93), with an overall g = 0.61.
Returns diminish with more tests. *Adesope, Trevisan & Sundararajan 2017, Review of Educational
Research* ([ERIC](https://eric.ed.gov/?id=EJ1141817)). Dunlosky et al. (2013, PSPI) ○ rated
practice testing and distributed practice as the only two "high utility" techniques of ten,
and rereading and highlighting as low utility.

**R2. Retrieval transfers, within limits. Grade A ✔**
Benefits of testing transfer to new questions and contexts (d ≈ 0.40). Transfer is strongest
across test formats and to application and inference questions, and is moderated by how
similar the responses are, initial accuracy, and elaborated retrieval. *Pan & Rickard 2018,
Psychological Bulletin* ([PDF](https://sc-pan.github.io/pdf/PR_2018W.pdf)).
→ Retrieval items should ask for *application and inference*, not just recall of the same
words, and early accuracy needs to be high enough for retrieval to succeed.

**R3. Spacing. Grade A ✔**
Spaced retrieval beats massed retrieval (g = 0.74). **Expanding vs uniform intervals: no
significant difference** (g = 0.03). *Latimier, Peyre & Ramus 2021, Educational Psychology
Review* ([link](https://link.springer.com/article/10.1007/s10648-020-09572-8)). The optimal gap
grows with the retention interval but shrinks as a *fraction* of it: about 20–40% of a one-week
retention interval, about 5–10% of a one-year interval. *Cepeda et al. 2008, Psychological
Science* ([PubMed](https://pubmed.ncbi.nlm.nih.gov/19076480/)).
→ Spacing matters a lot. The exact schedule matters much less, so a solid, open scheduler is
enough.

**R4. FSRS scheduler. Grade B ✔**
A memory model (difficulty, stability, retrievability) plus stochastic-shortest-path scheduling
improved on earlier schedulers by about 12.6%. *Ye, Su & Cao 2022, KDD*
([DOI](https://doi.org/10.1145/3534678.3539081)). Open source and used in Anki.
→ The default scheduler. Its strength is predicting memory per item, not the "expanding"
pattern itself (see R3).

**R5. Pretesting and prequestions. Grade A ✔**
Attempting questions *before* studying improves later learning of that material, even when most
initial answers are wrong. This holds with text, video, and lectures. *Pan & Carpenter 2023,
Educational Psychology Review* ([link](https://link.springer.com/article/10.1007/s10648-023-09814-5)).
→ Lessons open with 1–3 "guess first" questions on content not yet taught, framed so wrong
answers are expected and free.

**R6. Interleaving: helps discrimination, depends on similarity. Grade A ✔**
Overall g = 0.42 and g = 0.34 for maths tasks. It *hurts* for word lists (g = −0.39). Effects
are stronger when categories are *similar to each other* and items within a category are
varied, and for more complex material. *Brunmair & Richter 2019, Psychological Bulletin*
([PDF](https://www.psychologie.uni-wuerzburg.de/fileadmin/06020400/2019/Brunmair_Richter_in_press__2019_META-ANALYSIS_OF_INTERLEAVED_LEARNING.pdf)).
→ Interleave **confusable** KCs (motion vs force transform rules, left vs right quaternion
multiplication). Don't interleave unrelated facts for the sake of it.

**R8. Question format: recall for learning when it succeeds, a reason tier for diagnosis. Grade B ✔**
*For learning*, short-answer quizzes with feedback beat multiple-choice quizzes and restudy on a
test 3 days later; without feedback the advantage reversed, because failed recall left nothing.
*Kang, McDermott & Roediger 2007, European Journal of Cognitive Psychology*
([PDF](https://www.gwern.net/docs/spaced-repetition/2007-kang.pdf)). Across four experiments
(372 students) short-answer and hybrid (recall, then choose) showed little or no advantage over
multiple choice, except when initial recall succeeded more often: retrieval *success* matters,
not difficulty for its own sake. *Smith & Karpicke 2014, Memory*
([PDF](https://learninglab.psych.purdue.edu/downloads/2014/2014_Smith_Karpicke_Memory.pdf)).
Multiple choice with *plausible, competitive* alternatives triggers productive retrieval,
including of why the wrong options are wrong. *Little, Bjork, Bjork & Angello 2012,
Psychological Science* ([PDF](https://bjorklab.psych.ucla.edu/wp-content/uploads/sites/13/2017/01/LittleBjorkMC2014.pdf)).
*For diagnosis*, guessing and test-wiseness (answering by elimination) add construct-irrelevant
variance to multiple-choice scores; multiple-choice and constructed-response scores correlate
only moderately across exams (Rodriguez 2003, via
[this review](https://pmc.ncbi.nlm.nih.gov/articles/PMC5346173)). Two-tier items (the answer,
then the reason, with wrong reasons drawn from known misconceptions) diagnose misconceptions
better than plain multiple choice. *Treagust 1988; Tsui & Treagust 2010*
([review](https://www.lifescied.org/doi/10.1187/cbe.10-03-0048)).
→ To check understanding, prefer production: explain, predict in words, the first line you would
write. Use multiple choice where recall would mostly fail (pretests, beginners) and only with
misconception-based distractors, and give it a reason tier: credit needs the answer *and* the
reason. A choice alone stays weak evidence (recognition weight 0.5).

**R7. Learning vs performance. Grade A ○**
Performance during practice is a poor indicator of durable learning. Conditions that slow
practice (spacing, interleaving, generation) often improve retention and transfer: "desirable
difficulties". *Bjork 1994*; *Soderstrom & Bjork 2015, Perspectives on Psychological Science*.
→ Mastery may **not** be judged from same-session performance alone (rule M3 in the pedagogy
model).

---

## G. Generative and constructive activity

**G1. ICAP: engagement modes. Grade B ✔**
Learning increases from Passive (receiving) → Active (manipulating) → Constructive (generating
new output) → Interactive (co-constructing through dialogue). *Chi & Wylie 2014, Educational
Psychologist* ([PDF](https://education.asu.edu/sites/g/files/litvpz656/files/lcl/chiwylie2014icap_2.pdf)).
→ Every lesson component is tagged with its ICAP mode, and lessons must meet a minimum share of
constructive and interactive work. The tutor dialogue is how a solo learner gets the
"Interactive" mode.

**G2. Self-explanation. Grade A ✔**
Prompted self-explanation: g = 0.55 (64 reports, ~5,900 participants). **Prompts to explain
*concepts* beat metacognitive prompts** (to explain one's planning or performance). *Bisra et
al. 2018, Educational Psychology Review* ([ERIC](https://eric.ed.gov/?id=EJ1186664)).

**G3. Generation and prediction. Grade B ○**
Generating answers beats reading them. Predicting outcomes before observing them improves
conceptual learning (predict–observe–explain). *Slamecka & Graf 1978*; *White & Gunstone
1992*; *Brod 2021 (review of generative strategies)*.

**G4. Case comparison and contrasting cases. Grade A ✔/○**
Comparing cases supports schema learning and transfer. *Alfieri, Nokes-Malach & Schunn 2013,
Educational Psychologist* (meta-analysis; citation ✔, effect size not retrieved ○). Also
*Gentner, Loewenstein & Thompson 2003* ○, *Schwartz & Bransford 1998* ○.
→ "Contrast" components: two versions differing in one feature.

**G5. Erroneous examples. Grade B ✔**
Finding, explaining, and fixing errors in worked examples gave no difference on the immediate
test but a **better delayed test** than conventional problem solving. *McLaren, Adams & Mayer
2015, IJAIED* ([link](https://link.springer.com/article/10.1007/s40593-015-0064-x)). In the
worked-examples meta-analysis (W1), however, correct examples *alone* beat incorrect or mixed
examples on average.
→ Use erroneous examples after the correct model is in place (medium mastery), not as the
first exposure.

---

## W. Guidance, worked examples, and the assistance dilemma

**W1. Worked examples. Grade A ✔**
g = 0.48 on maths performance (55 studies). Correct examples alone beat incorrect or mixed ones.
**Adding self-explanation prompts to worked examples moderated the effect *negatively*** in this
dataset. *Barbieri et al. 2023, Educational Psychology Review* ([ERIC](https://eric.ed.gov/?id=EJ1364058)).
→ Worked examples for novices. Self-explanation prompts must be sparse and focused on
concepts (agrees with G2), not attached to every step.

**W2. Expertise reversal. Grade A ✔**
Guidance that helps novices hurts more knowledgeable learners by interfering with their
existing schemas. Support should be **adapted dynamically** as expertise grows, and rapid
diagnostic tests (e.g. "first-step" probes) can drive that adaptation. *Kalyuga 2007,
Educational Psychology Review* ([link](https://link.springer.com/article/10.1007/s10648-007-9054-3));
*Kalyuga et al. 2003* ○.
→ **This is the main personalisation lever.** Scaffold level per KC is driven by evidence.

**W3. Fading. Grade B ○**
Gradually removing worked steps (backward fading) bridges studying examples and solving
problems. *Renkl & Atkinson 2003*.

**W4. The assistance dilemma. Grade B ✔**
Giving vs withholding information is the central open problem of tutoring design. The answer
depends on conditions, and too much *and* too little help both harm learning. *Koedinger &
Aleven 2007, Educational Psychology Review* ([link](https://link.springer.com/article/10.1007/s10648-007-9049-0)).
→ Help is a *graduated* ladder, and the level is a parameter the system learns per learner.

**W5. Productive failure. Grade A ✔**
Problem solving *before* instruction (PS-I) beats instruction first on conceptual
understanding and transfer (g = 0.36, 166 comparisons, more than 12,000 participants) without
harming procedural knowledge. **Only with high fidelity**: the initial problem must invite
multiple solution attempts that activate prior knowledge, and must be followed by
consolidation that builds on those attempts. *Sinha & Kapur 2021, Review of Educational
Research* ([ERIC](https://eric.ed.gov/?id=EJ1308129)).
→ Reconciled with W1/W2: PS-I suits *conceptual* goals when prior knowledge can be activated.
Worked examples suit novices on *procedural* goals.

**W6. Prior knowledge. Grade A ✔**
Prior knowledge strongly predicts later knowledge (r ≈ .53) but does **not** reliably predict
*gains*. The effect on learning ranges from strongly positive to strongly negative.
*Simonsmeier et al. 2022, Educational Psychologist*
([PDF](https://www.uni-trier.de/fileadmin/fb1/prof/PSY/PAE/Team/Schneider/SimonsmeierEtAl_2021.pdf)).
→ Prior knowledge helps when it is *correct and activated*. Prior *misconceptions* can hurt
learning, so the interview must look for them, not just measure "level".

---

## T. Tutoring and adaptive systems

**T1. Intelligent tutoring systems work. Grade A ✔/○**
50 controlled evaluations show positive effects. *Kulik & Fletcher 2016, Review of Educational
Research* ([ERIC](https://eric.ed.gov/?id=EJ1090502); median effect not retrieved ○). Step-based
ITS approach human tutoring in effectiveness (d ≈ 0.76 vs ≈ 0.79). *VanLehn 2011* ○. Bloom's
"2 sigma" (1984) is an upper bound rarely replicated ○.
→ **Granularity matters:** feedback at the step level (our checkpoints per build step) is what
makes tutoring effective.

**T2. Mastery learning. Grade A ✔/○**
Across 108 evaluations, mastery programmes had positive effects on exam performance, stronger
for weaker students, at the cost of more time on task. *Kulik, Kulik & Bangert-Drowns 1990,
Review of Educational Research* ([PDF](http://competencyworks.pbworks.com/w/file/fetch/70372726/1170612.pdf)).
The often-cited ES ≈ 0.52 was not confirmed in this pass ○.

**T3. Knowledge tracing: simple models are competitive. Grade B ✔**
Across nine datasets, logistic-regression models with good features led on moderate-size
data, deep models led on very large data, and **BKT lagged both**. *Gervet, Koedinger,
Schneider & Mitchell 2020, Journal of Educational Data Mining* ([ERIC](https://eric.ed.gov/?id=EJ1273917)).
Elo-style ratings are simple, self-correcting, and need no training data. *Pelánek 2016,
Computers & Education* ([DOI](https://doi.org/10.1016/j.compedu.2016.03.017)).
→ We have **no population data**: each install is one learner, and the data never leaves the
device. So we use an Elo/logistic model with priors, not BKT and not deep models. This
**replaces** the BKT choice in the first draft.

**T4. Open learner models. Grade B ✔**
Showing learners their own model supports self-assessment, reflection, and planning. *Bull &
Kay 2010/2013* ([chapter](https://link.springer.com/chapter/10.1007/978-1-4419-5546-3_23)).
→ The "Me" page is a pedagogical feature, not just a settings screen.

**T5. Target difficulty. Grade C ✔**
For gradient-based learners, the optimal training error rate is about 15.87% (≈85% accuracy).
*Wilson, Shenhav, Straccia & Cohen 2019, Nature Communications*
([DOI](https://doi.org/10.1038/s41467-019-12552-4)). This is derived for *learning algorithms*
and binary tasks, so applying it to humans on complex tasks is an extrapolation.
→ Use it as a **starting point** for a tunable target band, not as a law.

---

## F. Feedback

**F1. Feedback works, but not all feedback. Grade A ✔**
d = 0.48 overall (435 studies), with high heterogeneity. **High-information feedback** (task-
and process-level, elaborated) works far better than praise, rewards, or grades. *Wisniewski,
Zierer & Hattie 2020, Frontiers in Psychology*
([link](https://www.semanticscholar.org/paper/The-Power-of-Feedback-Revisited:-A-Meta-Analysis-of-Wisniewski-Zierer/08dba618dd4fe18935409da79873b1149d85f373)).
*Hattie & Timperley 2007* ○, *Shute 2008* ○.

**F2. Hypercorrection. Grade B ○**
High-confidence errors, once corrected, are *more* likely to be fixed. *Butterfield & Metcalfe
2001*.

---

## M. Metacognition and affect

**M1. Feeling of learning ≠ learning. Grade B ✔**
In a randomised physics-course study, students learned more in active classes but *felt* they
learned less, partly because of the higher cognitive effort. Explaining this up front helped.
*Deslauriers et al. 2019, PNAS* ([PDF](https://www.pnas.org/doi/pdf/10.1073/pnas.1821936116)).
→ The app tells the learner, briefly and once per context, why effort feels like
not-learning.

**M2. Miscalibration. Grade B ○**
People misjudge their competence (*Kruger & Dunning 1999*; the size and interpretation of the
effect are debated) and their learning (*Bjork, Dunlosky & Kornell 2013*).
→ Self-report has low weight. Calibration is measured and shown.

**M3. Confusion helps when it is resolved. Grade B ✔**
Confusion triggered by contradictions can benefit learning *if it is regulated and resolved*.
Unresolved confusion turns into frustration and harm. *D'Mello, Lehman, Pekrun & Graesser
2014, Learning and Instruction* ([record](https://acuresearchbank.acu.edu.au/item/8v7v6/confusion-can-be-beneficial-for-learning)).
→ The tutor doesn't rush to remove confusion. It watches for signs of being stuck and steps
in before frustration sets in (rule H4).

---

## P. Presentation

**P1. Learning styles: no support. Grade A ○**
No credible evidence that matching instruction to a self-reported style (visual, auditory,
etc.) improves learning. *Pashler, McDaniel, Rohrer & Bjork 2008, PSPI*.

**P2. Multimedia principles. Grade A ○**
Words plus relevant graphics beat words alone. Signalling, spatial and temporal contiguity,
coherence (no decoration), and segmenting all help. *Mayer, Multimedia Learning, 3rd ed. 2021*.

**P3. Concreteness fading. Grade B ○**
Moving from concrete → iconic → abstract representations improves transfer. *Fyfe, McNeil, Son
& Goldstone 2014*.

---

## C. Programming-specific

**C1. Reading and tracing come before writing. Grade B ✔**
Novices who couldn't trace code reliably also couldn't explain it. Tracing skill underlies
writing skill. *Lister et al. 2004, ACM SIGCSE Bulletin* ([portal](https://research.aalto.fi/en/publications/a-multi-national-study-of-reading-and-tracing-skills-in-novice-pr/)).
→ For low-mastery programming KCs: trace tasks (predict the output, step through) before
write tasks. This is the logic of PRIMM (*Sentance, Waite & Kallia 2019* ○).

**C2. Parsons problems are efficient. Grade B ✔**
Same learning and one-week retention as writing or fixing code, in significantly less time.
*Ericson, Margulieux & Rick 2017, Koli Calling*
([record](https://www.semanticscholar.org/paper/Solving-parsons-problems-versus-fixing-and-writing-Ericson-Margulieux/2f1b7c75a3cc2f33fc34575bbe77eeb1f336debc)).

**C3. Subgoal labels. Grade B ✔**
Labelling the subgoals in worked code examples improves performance over the same examples
without labels, in text-based languages too. *Morrison, Margulieux & Guzdial 2015, ICER*
([PDF](https://digitalcommons.unomaha.edu/cgi/viewcontent.cgi?params=%2Fcontext%2Fcompsicfacproc%2Farticle%2F1062%2F&path_info=Subgoals__Context__and_Worked_Examples_in_Learning_Computing_Problem_Solving.pdf)).

---

## AI. LLM tutors (the newest and most relevant evidence)

**AI1. Unguarded AI harms learning. Grade B ✔**
~1,000 students: GPT-4 access improved practice (+48%) but **reduced** unassisted exam
performance (−17%). A guardrailed tutor (+127% in practice) largely removed the harm. *Bastani
et al. 2025, PNAS* ([link](https://www.pnas.org/doi/10.1073/pnas.2422633122)).

**AI2. Substitution vs complement. Grade B ✔**
In programming courses (observational data plus experiments), using LLMs to *substitute*
learning activities (generating solutions) widened topic coverage but reduced understanding.
Using them to *complement* learning (explanations, tutoring) improved understanding. **LLMs
widened the gap between low and high prior-knowledge students.** *Lehmann, Cornelius & Sting,
"AI Meets the Classroom"* ([arXiv](https://arxiv.org/abs/2409.09047)).
→ This is the clearest evidence for our core rule, and a warning that **novices need *more*
structure from an AI tutor, not less**.

**AI3. Well-designed AI tutoring beats active learning. Grade B ✔**
Crossover RCT with 194 physics students: median learning gains more than doubled vs in-class
active learning, in less time. The tutor's design: step-by-step scaffolding, no answer
revealing, cognitive-load management, and growth-oriented feedback. *Kestin et al. 2025,
Scientific Reports* ([link](https://www.nature.com/articles/s41598-025-97652-6)).

**AI4. AI tutoring at scale. Grade B ✔**
Six-week after-school programme with GPT-4 (Nigeria, RCT): +0.31 SD overall, +0.23 SD on
English, with teacher supervision and prompts designed to promote reasoning. *De Simone et al.
2025, World Bank* ([summary](https://voxdev.org/topic/education/how-ai-tutors-improved-learning-nigeria)).

**AI5. LLM hints ≈ human hints, but unreliable unless checked. Grade B ✔**
ChatGPT hints produced learning gains equivalent to human-tutor hints. But **32% failed
quality checks** before mitigation, reduced to ~0–13% with self-consistency checking. *Pardos &
Bhandari 2024, PLOS ONE* ([link](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0304013)).
→ Factual content the tutor produces should be **checked by something** (tests, a second
sampling, the learner's own verification) wherever that is cheap.

**AI6. Guardrailed programming assistants. Grade C ✔**
CodeHelp: an LLM assistant with guardrails that resolves student issues without giving
solution code. It was deployed and well received, but this is a deployment study, not an RCT.
*Liffiton et al. 2023, Koli Calling* ([ACM](https://dl.acm.org/doi/fullHtml/10.1145/3631802.3631830)).

**AI7. Pedagogical instruction following. Grade C ✔**
Training and prompting models with explicit pedagogical instructions improved expert-rated
pedagogy across 49 scenarios. *LearnLM tech report, Google 2024*
([arXiv](https://arxiv.org/pdf/2412.16429)).
→ Pedagogy written as *explicit system instructions* is a valid approach, and it is ours. The
LearnLM rubric dimensions inform our evals.

**AI8. LLM-as-judge is usable with care. Grade C ✔**
Rubric-based LLM grading agrees reasonably with humans, but it is less consistent than human
raters and sensitive to rubric wording (one revised rubric cut mis-scores from 45% to 14%). A
0–5 scale gave the best alignment, and self-consistency plus selective human review improves
reliability. (Several 2025–26 studies; see
[Reliability without Validity](https://arxiv.org/html/2606.19544v1),
[self-consistency grading](https://www.mdpi.com/2504-4990/8/3/74).)
→ LLM-judged explanations count as evidence with **reduced weight**, need **agreement across
samples**, and the learner can always see and dispute them.

**AI9. "Cognitive debt": contested. Grade D ✔**
An EEG study reported lower neural connectivity and recall when writing with ChatGPT. *Kosmyna
et al. 2025* (preprint), which is criticised for small sample, EEG methods, and reporting
([comment](https://arxiv.org/pdf/2601.00856)). Not used as evidence. It points the same way as
AI1/AI2, which carry the argument on their own.

---

## MO. Motivation

**MO1. Self-determination theory. Grade A ○**
Intrinsic motivation grows from autonomy, competence, and relatedness. *Ryan & Deci 2000*.

**MO2. Rewards can undermine interest. Grade A ✔**
In 128 studies, engagement-, completion-, and performance-contingent *expected tangible*
rewards undermined free-choice intrinsic motivation. Verbal (informational) rewards did not
have this effect for college students. *Deci, Koestner & Ryan 1999, Psychological Bulletin*
([PDF](https://home.ubalt.edu/tmitch/642/articles%20syllabus/Deci%20Koestner%20Ryan%20meta%20IM%20psy%20bull%2099.pdf)).

**MO3. Gamification: small-to-medium effects, narrative helps. Grade A ✔**
Cognitive g = 0.49, motivational g = 0.36, behavioural g = 0.25. Narrative and game-world
elements are especially promising. *Sailer & Homner 2020, Educational Psychology Review*
([ERIC](https://eric.ed.gov/?id=EJ1245270)).

**MO4. Streaks: engagement yes, learning unclear, anxiety risk. Grade D ✔**
Industry data (Duolingo) shows streaks increase retention. Lenient streaks (freezes) *raised*
engagement, and "streak anxiety" is widely reported. Peer-reviewed learning evidence is thin.
([overview](https://yukaichou.com/gamification-analysis/streak-design-gamification-motivation-burnout/))

**MO5. Utility value. Grade B ✔**
Having students write about how the material connects to their own lives raised interest and
grades, especially for those with low expectations of success. *Hulleman & Harackiewicz 2009,
Science* ([record](https://www.researchgate.net/publication/232580960_Enhancing_Interest_and_Performance_With_a_Utility_Value_Intervention)).
→ The learner's own stated "why" is re-connected to each lesson, and the learner *writes* the
connection; it isn't only stated for them.

**MO6. Interest develops in phases. Grade B ✔**
Triggered situational → maintained situational → emerging individual → well-developed
individual interest. Early phases need external support (novelty, hooks, structure). Later
phases need autonomy and deeper challenge. *Hidi & Renninger 2006, Educational Psychologist*
([ERIC](https://eric.ed.gov/?id=EJ736298)).

**MO7. Implementation intentions. Grade A ✔**
"If X, then I will Y" plans improve goal attainment (d = 0.65, 94 studies). *Gollwitzer &
Sheeran 2006* ([chapter](https://www.sciencedirect.com/science/chapter/bookseries/abs/pii/S0065260106380021)).
→ Session planning uses if-then plans ("If it's Tuesday 20:00, I open lesson 10, step 3").

**MO8. Curiosity gap. Grade C ○**
Curiosity arises from a perceived gap in knowledge. *Loewenstein 1994*.

**MO9. Mindset interventions: small. Grade B ○**
Small average effects with high variability. *Sisk et al. 2018*.

---

## Gaps (what the evidence does *not* tell us)

1. **Optimal hint-ladder design for LLM tutors.** There is no head-to-head evidence on how
   many levels or which types. Our ladder is derived from W4, AI1, AI2, and AI6 (grade C).
2. **Adult self-directed learners on long, real projects.** Most studies use students on short
   units. Our first user (and most users) are adults learning on long projects.
3. **Long-term effects of AI tutoring** beyond weeks.
4. **Learner modelling with n = 1 and no population priors.** The literature assumes
   population datasets.

These gaps are why `pedagogy-model.md` makes every threshold a **named, tunable parameter**,
and why the app logs enough (locally) for the learner to see whether it works for them. If the
project grows, the gaps become an open-source research opportunity, through opt-in, anonymised,
user-exported datasets. That is never automatic.
