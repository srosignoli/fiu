# Kintsugi

Kintsugi is a CLI that turns code in a developer's own repository into small, verified practice exercises, so they keep understanding code they (or AI agents) didn't write by hand.

## Language

### Exercises

**Workout**:
A single, verified practice exercise derived from real code in the user's repository.
_Avoid_: Exercise, challenge, kata (as the umbrella term)

**Kata**:
A Workout where the human fills a deliberate gap in otherwise working code.
_Avoid_: Standard kata, skeleton

**Drill**:
A Workout where the human diagnoses and fixes a single realistic bug injected into otherwise working code.
_Avoid_: Chaos kata, chaos drill, mutant debugging, incident

**Track**:
An ordered sequence of Workouts that together teach one module of the repository. A Track is not itself a Workout.
_Avoid_: Ladder, learning path, exploration

**Quick**:
A size constraint on a Workout (completable in about five minutes), not a separate kind of Workout.
_Avoid_: Micro-kata, wait-time kata

### Anatomy of a Workout

**Starting Code**:
The code the human receives: the Kata's gapped code or the Drill's bugged code.
_Avoid_: initialUserCode, skeleton, mutant

**Reference Solution**:
The complete, correct implementation that the Workout's tests are proven against.

**Hint**:
One of a fixed, ordered set of nudges prepared with a Workout and revealed to the human one at a time on request.
_Avoid_: Clue, tip

**Source Anchor**:
A pointer from a Workout back to the exact file, lines, and commit in the repository it was derived from.
_Avoid_: Source link, reference

**Regression Test**:
The test in a Drill that specifically exposes the injected bug.

**Verified**:
A Workout is Verified when its Reference Solution passes every test; its Starting Code runs but fails at least one test by assertion while passing at least one other (for a Drill, the failures include the Regression Test); and its Starting Code differs from the Reference Solution by a single small region (the injected bug, or the gap).
_Avoid_: Valid, checked

### Languages

**Language Profile**:
Everything Kintsugi needs to know to build and run Workouts in one programming language: which source files it applies to, how its tests are run, and how their results are read. A Workout's language is that of the source file it was derived from.
_Avoid_: Adapter, language plugin, runtime

### Progress

**Completed**:
A Workout is Completed when the human's code passes every one of its tests.
_Avoid_: Solved, passed, mastered

**Abandoned**:
A Workout is Abandoned when the human gives up and reveals its Reference Solution before Completing it.
_Avoid_: Skipped, failed, given up
