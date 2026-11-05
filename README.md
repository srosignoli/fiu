# Fiutsu

**A nose for code you never typed.**

*Fiutsu* is *fiuto* (Italian, "a nose for it") plus *-jutsu* (Japanese 術, "art, technique", as in jujutsu): the art of knowing code you didn't write.

AI agents write more and more of the code we're responsible for. Fiutsu keeps you fluent in it: it turns real code from your repository into small, **Verified** practice exercises (**Workouts**) that you solve with your own brain, paying down *comprehension debt* one Workout at a time.

## Workouts

| Kind | You… | Start one with |
| :--- | :--- | :--- |
| **Drill** | find and fix one realistic bug injected into otherwise working code | `fiu drill <file>[#symbol]` |
| **Kata** | rebuild a piece of the code that was removed, from a brief | `fiu kata <file>[#symbol]` |
| **Prediction** | read a Scenario and predict which of four outcomes the code produces | `fiu predict <file>` |
| **What-if** | predict what a change not yet made would do | `fiu predict <file> --what-if "<change>"` |
| **Diagnosis** | read a practice incident and choose which of four Causes explains it | `fiu diagnose <file>` |

Every answer is **measured by running code**, never asserted by the model: a Workout reaches you only if its tests prove it is what it claims to be.

## Principles

- **Voluntary and non-blocking.** Fiutsu never touches commits, CI, or the build.
- **Zero repo pollution.** All state lives in `.fiutsu/`, hidden through `.git/info/exclude`.
- **Generated code is untrusted.** Every Workout runs in an OS sandbox with no network.
- **No telemetry.** Nothing about your use of Fiutsu leaves your machine.
- **Called by agents, never driving them.** Use your own API key, or let your coding agent generate Workouts through Fiutsu's MCP server.

## Requirements

- Node.js ≥ 22.18
- Linux or macOS (Windows through WSL)
- `git`, and the toolchain of the language you practise (Node.js, Python 3, or Go are built in)
- An API key for a supported cloud provider, **or** Claude Code (agent mode)

## Quick start

```sh
# From a clone of this repository
npm install && npm run build && npm link

# In the repository you want to practise on
fiu init                     # create .fiutsu/ and check the sandbox
fiu drill src/queue.ts       # generate a Drill and open it in the runner
fiu train                    # pick up a pending Workout later
```

With Claude Code instead of an API key:

```sh
fiu agent install claude     # skill, /fiu-drill and /fiu-atlas commands, MCP server
```

Then ask Claude Code for a drill (or type `/fiu-drill src/queue.ts`), and start it with `fiu train`.

## More commands

- `fiu explore <dir>` / `fiu track`: a Track of Workouts that walks you through a module.
- `fiu map`: your comprehension debt by directory.
- `fiu atlas`: what each folder, file, and key function is for.
- `fiu stats`: how often your Predictions are right, and your Blind Spots.
- `fiu quick [--while "<cmd>"]`: a short Workout right away, or while a slow command runs.
- `fiu auto on`: a Quick Drill from each of your commits, in the background.
- `fiu share` / `fiu fetch`: share Workouts with your team.
- `fiu cost`: what generating Workouts has cost.

`fiutsu` is the full name of the binary; `fiu` is its short alias. See [SPEC.md](./SPEC.md) for the full reference, [GLOSSARY.md](./GLOSSARY.md) for the domain terms, and [docs/adr/](./docs/adr/) for the decisions behind them.

## Formerly Kintsugi

Up to v5.1 this project was called Kintsugi. The first time you run `fiu` it moves your existing state for you (see SPEC.md, §3.1). If you used the Claude Code integration, run `fiu agent install claude` once to replace it.

## License

MIT
