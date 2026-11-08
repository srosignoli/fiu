# Fiu

Fiu is a CLI that turns code in a developer's own repository into small, verified practice exercises, so they keep understanding code they (or AI agents) didn't write by hand.

## Language

### Exercises

**Workout**:
A single, verified practice exercise derived from real code in the user's repository. A Workout is an immutable definition: it can be attempted any number of times.
_Avoid_: Exercise, challenge, kata (as the umbrella term)

**Attempt**:
One try at a Workout, worked on in its own fresh copy of the Workout's Starting Code. Outcomes belong to Attempts, not to Workouts.
_Avoid_: Session, try, run (a run is one execution of the tests)

**Kata**:
A Workout where the human fills a deliberate gap in otherwise working code.
_Avoid_: Standard kata, skeleton

**Drill**:
A Workout where the human diagnoses and fixes a single realistic bug injected into otherwise working code.
_Avoid_: Chaos kata, chaos drill, mutant debugging, incident

**Prediction**:
A Workout where the human reads a Scenario and predicts which of four outcomes the system produces, without reading code. Each outcome is measured by running code, never asserted by the model.
_Avoid_: Quiz, question, scenario (as the umbrella term)

**Diagnosis**:
A Workout where the human reads a practice incident and chooses which of four Causes explains it, without reading code. Each Cause's link to its Symptom is measured by running code, never asserted by the model.
_Avoid_: Triage, root-cause quiz, incident (the incident is what it shows)

**What-if**:
A Prediction about a Proposed Change: what the code would do with it, in a situation where that differs from today. Its outcomes are measured; that the code matches the change as worded is the model's reading, shown to the human.
_Avoid_: Simulation, scenario (that's the situation it asks about), impact analysis

**Proposed Change**:
A change that hasn't been made, typed by the human or suggested by the model, modelled in a self-contained copy of one unit. Nothing in the repository changes.
_Avoid_: Patch, diff

**Series**:
Several Predictions about the same unit of code, generated together and answered one after another. Each question is its own Prediction, Verified and attempted on its own. A Series is not itself a Workout.
_Avoid_: Quiz, question set, batch

**Track**:
An ordered sequence of 3 to 5 Workouts of mixed kinds, each from a different file, that together teach one module of the repository, foundations first. A Track is not itself a Workout.
_Avoid_: Ladder, learning path, exploration

**Atlas**:
A map of the repository saying what each folder, file, and key function is for, so the human can choose what to practise. Its structure is computed from the code; its descriptions are written by a model and never Verified. The Atlas is not a Workout.
_Avoid_: Assessment, index, overview (that's one Atlas Entry)

**Link**:
A relationship between two source files that Fiu computes, never a model: one imports the other, or they change in the same commits (co-change). Shown beside the Atlas, true by construction, and never Verified, because it isn't a Workout.
_Avoid_: Dependency (a package), edge, call (links are between files, not functions)

**Atlas Entry**:
One model-written description in the Atlas (of the repository, a folder, a file, or a key function), tied to the exact content it describes; stale once that content changes.
_Avoid_: Summary, annotation

**Quick**:
A size constraint on a Workout (completable in about five minutes), not a separate kind of Workout.
_Avoid_: Micro-kata, wait-time kata

### Anatomy of a Workout

**Starting Code**:
The code the human receives: the Kata's gapped code or the Drill's bugged code.
_Avoid_: initialUserCode, skeleton, mutant

**Reference Solution**:
The complete, correct implementation that the Workout's tests are proven against. For a Prediction, the code whose behaviour is the true outcome.

**Scenario**:
The plain-English situation a Prediction asks about, with concrete values and no code vocabulary.
_Avoid_: Question, prompt, story

**Previous Version**:
For a Prediction from a commit: the same unit extracted from the file as it was before the commit. What it does is the old-behaviour option's outcome; its changed lines must be found in the old file.
_Avoid_: Old code, before-version, baseline

**Variant**:
For one wrong option of a Prediction: the Reference Solution with a single small region changed to model a plausible misunderstanding. What it does is that option's outcome.
_Avoid_: Mutant, distractor, decoy

**Cause**:
One of a Diagnosis's four possible explanations: plain English, with a Variant of the code. Exactly one is true for the incident shown.
_Avoid_: Option, answer, root cause

**Symptom**:
What users would see if a Cause were real, measured by its test: that test passes against the Cause's Variant and fails against the healthy code and every other Variant. The true Cause's Symptom is the incident shown.
_Avoid_: Incident report (that's a Drill's README), error

**Hint**:
One of a fixed, ordered set of nudges prepared with a Workout and revealed to the human one at a time on request.
_Avoid_: Clue, tip

**Source Anchor**:
A pointer from a Workout back to the exact file, lines, and commit in the repository it was derived from.
_Avoid_: Source link, reference

**Origin**:
Why a Workout exists: requested by the human for a chosen file (manual), generated in the background from a commit, made by an agent at the end of its task, or created as a step of a Track.
_Avoid_: Source (that's the code it was derived from), trigger, mode

**Generator**:
Who wrote a Workout's content: Fiu itself (calling an LLM with the user's API key), or the user's own coding agent (through Fiu's tools). Independent of Origin.
_Avoid_: Provider, mode, backend

**Regression Test**:
The test in a Drill that specifically exposes the injected bug.

**Verified**:
A Workout is Verified when its Reference Solution passes every test; its Starting Code runs but fails at least one test by assertion while passing at least one other (for a Drill, the failures include the Regression Test); and its Starting Code differs from the Reference Solution by a single small region (the injected bug, or the gap). A Prediction is Verified when, against the Reference Solution, only the true option's test passes; against each Variant, only that option's test passes; every other test fails by assertion; and each Variant differs from the Reference Solution by a single small region. A Prediction from a commit must also pass against its Previous Version in the same way, and that version's changed lines must be found in the file before the commit. A Diagnosis is Verified when, against the Reference Solution, no Symptom test passes; against each Cause's Variant, only that Cause's test passes; every other test fails by assertion; and each Variant differs from the Reference Solution by a single small region.
_Avoid_: Valid, checked

### Languages

**Language Profile**:
Everything Fiu needs to know to build and run Workouts in one programming language: which source files it applies to, how its tests are run, and how their results are read. A Workout's language is that of the source file it was derived from.
_Avoid_: Adapter, language plugin, runtime

### Progress

**Completed**:
An Attempt is Completed when the human's code passes every one of the Workout's original tests (editing the tests to pass doesn't count). An Attempt at a Prediction or Diagnosis is Completed when its one answer is the true one.
_Avoid_: Solved, passed, mastered

**Abandoned**:
An Attempt is Abandoned when the human gives up and reveals the Reference Solution before Completing it. An Attempt at a Prediction or Diagnosis is Abandoned when its one answer is wrong: the truth is then revealed.
_Avoid_: Skipped, failed, given up

**Practised**:
A source file is Practised once the human has finished an Attempt (Completed or Abandoned) on a Workout derived from it.
_Avoid_: Covered, mastered, learned

**Stale**:
Practice on a file is Stale when the file has changed substantially since the code the practised Workout was derived from.
_Avoid_: Outdated, expired (expiry is for queued Workouts)

**Blind Spot**:
A file where the human's most recent first answer to a Prediction or Diagnosis was certain and wrong: a confident, wrong picture of what the code does. A later right answer on that file clears it.
_Avoid_: Weak spot, gap, debt (that's the map's word for unpractised code)

**Discarded**:
A Workout is Discarded when it is removed without being attempted, by the human or because it went stale.
_Avoid_: Deleted, expired, skipped
