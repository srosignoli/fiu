# Fiu

**A nose for code you never typed.**

*Fiu* comes from *fiuto*, Italian for "a nose for it": a nose for code you never typed, the knack of knowing code you didn't write.

AI agents write more and more of the code we own. Fiu keeps you fluent in it. It turns real code from your repository into small, **Verified** exercises (**Workouts**) that you solve yourself, paying down *comprehension debt* one Workout at a time.

## Workouts

Workouts support two paths: hands-on code fixes in an editor (**Drill**, **Kata**) or mental-model verification straight in the terminal without opening an IDE (**Prediction**, **What-if**, **Rule check**, **Diagnosis**).

| Kind | Mode | You… | Start one with |
| :--- | :--- | :--- | :--- |
| **Drill** | Editor | find and fix one realistic bug injected into working code | `fiu drill <file>[#symbol]` |
| **Kata** | Editor | rebuild a removed piece of application logic from a brief | `fiu kata <file>[#symbol]` |
| **Prediction** | Terminal | read a Scenario and predict which of four outcomes the code produces (`--questions N` for a Series) | `fiu predict <file>` |
| **What-if** | Terminal | predict how a proposed change would alter system behavior | `fiu predict <file> --what-if "<change>"` |
| **Rule check** | Terminal | a Prediction about a business rule (from your `.fiu-rules.md`, an Understand-Anything domain graph, or typed): does the code really do what the rule says? | `fiu predict --rule "<words>"` |
| **Diagnosis** | Terminal | read a practice incident and choose which of four Causes explains it | `fiu diagnose <file>` |

For **Drills** and **Katas**, `fiu train` copies the code and unit tests into a fresh `.fiu/attempts/<id>/<n>/` directory and prints its paths. You read `README.md`, inspect the unit tests, and edit the code in your preferred editor while `fiu train` re-runs the tests on every save. If `$VISUAL` is not set, open the printed `.fiu/attempts/...` files directly in your editor. If `$VISUAL` is set, Fiu spawns it detached so `fiu train` keeps your terminal: use a GUI editor (`VISUAL="code"`) or prefix a terminal editor with your terminal emulator (`VISUAL="kitty vim"` or `VISUAL="gnome-terminal -- vim"`). The original Workout in `.fiu/workouts/` stays untouched so you can redo it later or share it with your team.

Every Workout's README opens with **Around this code**: what the folder and file are for (the folder only, for a Prediction), what uses the code, what it uses, and what changes with it. It never describes the code you are working on itself (turn both off with `"context": false` in `.fiu/config.json`). After every Workout, a **Debrief** shows where the code lives, what it is for, which business flows it belongs to, rules it may enforce, who calls it, its tensions (blast radius, churn, hidden coupling), and which neighbours to practise next.

Every answer is **measured by running code** inside an OS sandbox, never asserted by the model. The **Verified Gate** accepts a Workout only when its tests prove the real behavior and every distractor Variant in isolation. If a Drill's buggy lines match your actual source file verbatim, Fiu also flags that the bug may already exist for real once you finish the Attempt.

## Passive vs. Active Learning: The Atlas and Understand-Anything

In Fiu, the **Atlas** (`fiu atlas` and `fiu map`) is the entry point to your codebase. It describes what each folder, file, and key symbol is for. Alongside it, Fiu computes **Links** directly from imports and git history (`Uses`, `Used by`, `Changes with`).

Mastering a codebase benefits from two complementary strategies: **passive learning** (architectural exploration and reading) and **active learning** (hands-on practice and verification). [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) (`UA`) excels at the **passive** side by generating a rich knowledge graph of summaries, architectural layers, guided tours, business flows, and domain rules. Fiu provides the **active** side through verified Workouts that test and reinforce your mental model.

Fiu's built-in Atlas is much lighter than Understand-Anything in both information depth and token consumption, so the two are not directly comparable. Fiu works standalone with its own Atlas (`fiu atlas build`). That built-in Atlas gives you everything needed to orient yourself and pick Workouts at a fraction of the token cost.

However, if your team already uses Understand-Anything (`.understand-anything/` or `.ua/`), combining the two tools gives you the best setup to unite both strategies. You get broad **passive** orientation from Understand-Anything alongside **active**, sandbox-verified practice from Fiu. Fiu reuses that existing graph with zero flags (`"understandAnything": false` turns it off):

- **Zero-cost Atlas overlay:** Fiu uses current `(UA)` summaries where its own Atlas has none. Running `fiu atlas build` skips those files so you never pay twice for tokens already spent.
- **Tracks along business flows (`fiu explore --flow "<name>"`):** Build multi-step Tracks that follow an end-to-end business flow in execution order instead of a single folder.
- **Measured rule checks (`fiu predict --rule` and `fiu map --flows`):** Turn business rules—from `.fiu-rules.md`, Understand-Anything's domain graph, or typed on the CLI—into sandboxed Predictions that measure whether the code follows the rule.

## Standard-Library Isolation and Supported Languages

Every Workout in Fiu consists of one code file and one test file using **only the language's standard library and built-in test runner**. When Fiu extracts a unit of code, it replaces frameworks, third-party libraries, databases, and queues with small inline fakes or parameters. This serves two goals:

1. **Focus on your core logic, not framework trivia:** You practise your application's real algorithms and business rules without wrestling with framework boilerplate or external library APIs.
2. **Hermetic, portable verification:** Because Workouts never import `node_modules` or `.venv` and need no external services, they run in milliseconds inside the OS sandbox. They also behave identically on every teammate's machine when shared via `fiu fetch`.

Out of the box, Fiu includes built-in **Language Profiles** for four languages:

- **TypeScript** (`.ts`, `.mts`, `.cts`, `.tsx` via `node --test` with type stripping)
- **JavaScript** (`.js`, `.mjs`, `.cjs`, `.jsx` via `node --test`)
- **Python** (`.py` via `python3 -m unittest`)
- **Go** (`.go` via `go test -json`)

Extending Fiu to other languages—such as Rust, Ruby, Java, or C#—requires zero changes to the core engine. A Language Profile is pure configuration data. You can declare a new language under `"profiles"` in `.fiu/config.json` (or contribute a built-in profile in `src/languages/builtin.ts`). Each profile specifies `extensions`, `codeFilename`, `testFilename`, static `supportFiles`, `preflightCmd`, `testCmd` (emitting `tap` or `junit-xml`), an optional `declarationPattern` regex, and sandbox `cacheDirs`.

## Quick start

```sh
# From a clone of this repository
npm install && npm run build && npm link

# In the repository you want to practise on
fiu init                     # create .fiu/ and check the sandbox
fiu atlas build              # map what each folder, file, and key symbol does
fiu drill src/queue.ts       # generate a Drill and open it in the runner
fiu train                    # practise any pending Workout, Series, or Track
```

With Claude Code instead of an API key:

```sh
fiu agent install claude     # install the MCP server, subagent skill, and /fiu-* commands
```

Ask Claude Code for a Workout (or run `/fiu-drill src/queue.ts` and `/fiu-atlas`). Claude delegates generation to a low-cost subagent, keeping your main coding session's context window clean.

## Key workflows

- `fiu atlas` / `fiu atlas <file>` / `fiu atlas search "<goal>"`: browse the codebase Atlas, see what a file uses, what uses it, and what changes with it, or find the files behind a goal.
- `fiu explore <dir>` / `fiu explore --about "<goal>"` / `fiu explore --flow "<name>"` / `fiu track`: build or continue a multi-step Track across a module, a goal, or a business flow from an Understand-Anything domain graph.
- `fiu quick [--while "<cmd>"]`: solve a Workout right away, or while an agent runs or a long build or pipeline finishes.
- `fiu map`: inspect comprehension coverage and locate unpractised hotspots. `fiu map --flows`: the same by business flow, with which business rules the code was checked against, when the repository has an Understand-Anything domain graph.
- `fiu stats`: track your Prediction accuracy, confidence calibration, and **Blind Spots**.
- `fiu share [--atlas]` / `fiu fetch`: share verified Workouts and the Atlas with your team on the `fiu/workouts` branch without touching `main`.
- `fiu auto on`: queue a background Quick Drill from each commit. Optional: `--rules` turns a commit that changes code where a business rule is pinned or already checked into a rule check; `--model <id>` uses a cheaper model for background work (every Workout is still Verified).
- `fiu cost`: inspect token usage and generation cost.

The binary is `fiu`. See [SPEC.md](./SPEC.md) for the specification, [GLOSSARY.md](./GLOSSARY.md) for domain terms, and [docs/adr/](./docs/adr/) for architecture decisions.

## Practise on Fiu itself

Fiu is practised on its own code. This repository carries two branches you can use from any clone, neither of which touches `main`:

```sh
# Workouts and Tracks generated from Fiu's own source, shared with `fiu share`
fiu fetch

# The Understand-Anything graph of Fiu, for flows, rule checks, and Atlas summaries
git fetch origin understand-anything
git restore --source=FETCH_HEAD --worktree -- .ua
```

The graph is a snapshot: its commit message names the commit it was built from, and summaries of files changed since then may describe older code.

## Principles

- **Voluntary and non-blocking.** Fiu never touches commits, CI, or the build.
- **Zero repo pollution.** Local state lives in `.fiu/`, hidden via `.git/info/exclude`.
- **Generated code is untrusted.** Every Workout runs in a network-isolated OS sandbox.
- **No telemetry.** Nothing about your use of Fiu leaves your machine.
- **Called by agents, never driving them.** Use your own API key, or let a coding agent call Fiu's MCP server.

## Requirements

- Node.js ≥ 22.18
- Linux or macOS (Windows through WSL)
- `git`, plus the toolchain for the language you practise (Node.js, Python 3, or Go built in)
- An API key for a supported cloud provider, **or** Claude Code (agent mode)

## Blog & Tutorial Series

- [Fiu: A Nose for Code You Never Typed](https://www.simonerosignoli.eu/fiu/fiu-introduction/) — why comprehension debt matters and how the Verified Gate works.
- [Tutorial 1: Workspace Setup, the Codebase Atlas, and Low-Cost Subagents](https://www.simonerosignoli.eu/fiu/fiu-getting-started-and-mcp/)
- [Tutorial 2: Troubleshooting Real Code with Drills and `fiu train`](https://www.simonerosignoli.eu/fiu/fiu-drills-and-train/)
- [Tutorial 3: Rebuilding Core Application Logic with Katas](https://www.simonerosignoli.eu/fiu/fiu-katas/)
- [Tutorial 4: Onboarding onto a Module with Mixed and Goal-Driven Tracks](https://www.simonerosignoli.eu/fiu/fiu-explore-and-tracks/)
- [Tutorial 5: Turning Idle Agent Wait Time into Practice with Quick Workouts](https://www.simonerosignoli.eu/fiu/fiu-quick-workouts-and-wait-time/)
- [Tutorial 6: Sharing the Atlas and Workouts on Git and Mapping Comprehension](https://www.simonerosignoli.eu/fiu/fiu-team-sharing-and-map/)
- [Tutorial 7: Mastering Your System Without Opening an IDE Using Predictions, What-Ifs, Diagnoses, and Calibration](https://www.simonerosignoli.eu/fiu/fiu-predictions/)
- [Tutorial 8: From Passive Graphs to Active Mastery with Understand-Anything, Flow Tracks, and Rule Checks](https://www.simonerosignoli.eu/fiu/fiu-understand-anything/)

## Formerly Fiutsu and Kintsugi

This project was called Fiutsu in v6.0 and Kintsugi up to v5.1. The first time you run `fiu` it moves your existing state for you (see SPEC.md, §3.1). If you used the Claude Code integration, run `fiu agent install claude` once to replace it. The `fiutsu` binary is gone: if you installed with `npm link`, run `npm link` again from this repository.

## License

[Apache-2.0](./LICENSE)
