# Workouts depend only on the standard library

Every Workout is a single code file plus a single test file that runs on the target language's standard library and built-in test runner alone. It never imports the user's installed dependencies (`node_modules`, `.venv`, etc.). Infrastructure the original code touched (databases, HTTP clients, Redis, etc.) is replaced with small inline fakes. As a result, a "library mechanics" Workout exercises the runtime's own primitives or a hand-written fake of the library, not the real library.

We chose this so verification is hermetic, fast, and identical on every machine. Running against the repo's real dependency tree would make whether a Workout is Verified depend on the user's install state, versions, and services, and would make generation far less reliable. Running Workouts against real dependencies may come later as an explicit opt-in.
