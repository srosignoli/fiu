# Fiutsu

**A nose for code you never typed.**

*Fiutsu* is *fiuto* (Italian, "a nose for it") plus *-jutsu* (Japanese 術, "art, technique", as in jujutsu): the art of knowing code you didn't write.

AI agents write more and more of the code we own. Fiutsu keeps you fluent in it. It turns real code from your repository into small, **Verified** exercises (**Workouts**) that you solve yourself, paying down *comprehension debt* one Workout at a time.

## Workouts

Workouts support two paths: hands-on code fixes in an editor (**Drill**, **Kata**) or mental-model verification straight in the terminal without opening an IDE (**Prediction**, **What-if**, **Diagnosis**).

| Kind | Mode | You… | Start one with |
| :--- | :--- | :--- | :--- |
| **Drill** | Editor | find and fix one realistic bug injected into working code | `fiu drill <file>[#symbol]` |
| **Kata** | Editor | rebuild a removed piece of application logic from a brief | `fiu kata <file>[#symbol]` |
| **Prediction** | Terminal | read a Scenario and predict which of four outcomes the code produces (`--count N` for a Series) | `fiu predict <file>` |
| **What-if** | Terminal | predict how a proposed change would alter system behavior | `fiu predict <file> --what-if "<change>"` |
| **Diagnosis** | Terminal | read a practice incident and choose which of four Causes explains it | `fiu diagnose <file>` |

Every answer is **measured by running code** inside an OS sandbox, never asserted by the model. The **Verified Gate** accepts a Workout only when its tests prove the real behavior and every distractor in isolation.

## Quick start

```sh
# From a clone of this repository
npm install && npm run build && npm link

# In the repository you want to practise on
fiu init                     # create .fiutsu/ and check the sandbox
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

- `fiu atlas` / `fiu atlas search "<goal>"`: browse the codebase Atlas or find the files behind a goal.
- `fiu explore <dir>` / `fiu track --goal "<goal>"`: build a multi-step Track across a module or data flow.
- `fiu quick [--while "<cmd>"]`: solve a 2-minute Workout right away, or while a build or agent runs.
- `fiu map`: inspect comprehension coverage and locate unpractised hotspots.
- `fiu stats`: track your Prediction accuracy, confidence calibration, and **Blind Spots**.
- `fiu share [--atlas]` / `fiu fetch`: share verified Workouts and the Atlas with your team on the `fiutsu/workouts` branch without touching `main`.
- `fiu auto on`: queue a background Quick Drill from each commit.
- `fiu cost`: inspect token usage and generation cost.

`fiutsu` is the full binary name; `fiu` is its short alias. See [SPEC.md](./SPEC.md) for the specification, [GLOSSARY.md](./GLOSSARY.md) for domain terms, and [docs/adr/](./docs/adr/) for architecture decisions.

## Principles

- **Voluntary and non-blocking.** Fiutsu never touches commits, CI, or the build.
- **Zero repo pollution.** Local state lives in `.fiutsu/`, hidden via `.git/info/exclude`.
- **Generated code is untrusted.** Every Workout runs in a network-isolated OS sandbox.
- **No telemetry.** Nothing about your use of Fiutsu leaves your machine.
- **Called by agents, never driving them.** Use your own API key, or let a coding agent call Fiutsu's MCP server.

## Requirements

- Node.js ≥ 22.18
- Linux or macOS (Windows through WSL)
- `git`, plus the toolchain for the language you practise (Node.js, Python 3, or Go built in)
- An API key for a supported cloud provider, **or** Claude Code (agent mode)

## Blog & Tutorial Series

- [Fiutsu: A Nose for Code You Never Typed](https://www.simonerosignoli.eu/posts/fiutsu-introduction/) — why comprehension debt matters and how the Verified Gate works.
- [Tutorial 1: Workspace Setup, the Codebase Atlas, and Low-Cost Subagents](https://www.simonerosignoli.eu/posts/fiutsu-getting-started-and-mcp/)
- [Tutorial 2: Troubleshooting Real Code with Drills and `fiu train`](https://www.simonerosignoli.eu/posts/fiutsu-drills-and-train/)
- [Tutorial 3: Rebuilding Core Application Logic with Katas](https://www.simonerosignoli.eu/posts/fiutsu-katas/)
- [Tutorial 4: Onboarding onto a Module with Mixed and Goal-Driven Tracks](https://www.simonerosignoli.eu/posts/fiutsu-explore-and-tracks/)
- [Tutorial 5: Turning Idle Agent Wait Time into Practice with Quick Workouts](https://www.simonerosignoli.eu/posts/fiutsu-quick-workouts-and-wait-time/)
- [Tutorial 6: Sharing the Atlas and Workouts on Git and Mapping Comprehension](https://www.simonerosignoli.eu/posts/fiutsu-team-sharing-and-map/)
- [Tutorial 7: Mastering Your System Without Opening an IDE Using Predictions, What-Ifs, Diagnoses, and Calibration](https://www.simonerosignoli.eu/posts/fiutsu-predictions/)

## Formerly Kintsugi

Up to v5.1 this project was called Kintsugi. The first time you run `fiu` it moves your existing state for you (see SPEC.md, §3.1). If you used the Claude Code integration, run `fiu agent install claude` once to replace it.

## License

MIT
