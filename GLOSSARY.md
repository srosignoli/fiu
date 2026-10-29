# Kintsugi

Kintsugi is a CLI that turns code in a developer's own repository into small, verified practice exercises, so they keep understanding code they (or AI agents) didn't write by hand.

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

**Track**:
An ordered sequence of 3 to 5 Workouts, each from a different file, that together teach one module of the repository, foundations first. A Track is not itself a Workout.
_Avoid_: Ladder, learning path, exploration

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

**Variant**:
For one wrong option of a Prediction: the Reference Solution with a single small region changed to model a plausible misunderstanding. What it does is that option's outcome.
_Avoid_: Mutant, distractor, decoy

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
Who wrote a Workout's content: Kintsugi itself (calling an LLM with the user's API key), or the user's own coding agent (through Kintsugi's tools). Independent of Origin.
_Avoid_: Provider, mode, backend

**Regression Test**:
The test in a Drill that specifically exposes the injected bug.

**Verified**:
A Workout is Verified when its Reference Solution passes every test; its Starting Code runs but fails at least one test by assertion while passing at least one other (for a Drill, the failures include the Regression Test); and its Starting Code differs from the Reference Solution by a single small region (the injected bug, or the gap). A Prediction is Verified when, against the Reference Solution, only the true option's test passes; against each Variant, only that option's test passes; every other test fails by assertion; and each Variant differs from the Reference Solution by a single small region.
_Avoid_: Valid, checked

### Languages

**Language Profile**:
Everything Kintsugi needs to know to build and run Workouts in one programming language: which source files it applies to, how its tests are run, and how their results are read. A Workout's language is that of the source file it was derived from.
_Avoid_: Adapter, language plugin, runtime

### Progress

**Completed**:
An Attempt is Completed when the human's code passes every one of the Workout's original tests (editing the tests to pass doesn't count). An Attempt at a Prediction is Completed when its one answer is the true option.
_Avoid_: Solved, passed, mastered

**Abandoned**:
An Attempt is Abandoned when the human gives up and reveals the Reference Solution before Completing it. An Attempt at a Prediction is Abandoned when its one answer is wrong: the truth is then revealed.
_Avoid_: Skipped, failed, given up

**Practised**:
A source file is Practised once the human has finished an Attempt (Completed or Abandoned) on a Workout derived from it.
_Avoid_: Covered, mastered, learned

**Stale**:
Practice on a file is Stale when the file has changed substantially since the code the practised Workout was derived from.
_Avoid_: Outdated, expired (expiry is for queued Workouts)

**Discarded**:
A Workout is Discarded when it is removed without being attempted, by the human or because it went stale.
_Avoid_: Deleted, expired, skipped
