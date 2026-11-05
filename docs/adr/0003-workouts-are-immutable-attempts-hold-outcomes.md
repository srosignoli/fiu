---
status: accepted (implementation planned for v2)
---

# A Workout is an immutable definition; outcomes belong to Attempts

A Workout (incident report, Starting Code, tests, Reference Solution, Hints, Source Anchors, generation cost) is written once, when it is Verified, and never edited or moved afterwards. The human works in an Attempt: a fresh copy of the Starting Code at `.fiutsu/attempts/<workout-id>/<n>/`. Completed and Abandoned are outcomes of Attempts, and a Workout can be attempted any number of times. Discarding a Workout archives it rather than deleting it.

v1 shipped the simpler model (edit the Workout in place, move it to `done/` when finished), which made every Workout one-shot. We changed it because Workouts cost real money to generate, so they should be reusable: redoing one months later must not require regenerating it, and sharing Workouts with a team (planned for v3) must not share one person's half-edited code. The cost is a migration of v1 data and a second directory tree to manage.
