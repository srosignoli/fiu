# Kintsugi: Specification (v1)

> Domain terms (Workout, Kata, Drill, Prediction, Scenario, Variant, Track, Quick, Starting Code, Reference Solution, Hint, Source Anchor, Regression Test, Verified, Language Profile, Completed, Abandoned) are defined in [GLOSSARY.md](./GLOSSARY.md). Decisions with lasting trade-offs live in [docs/adr/](./docs/adr/).

## 1. Vision

Kintsugi is an open-source, language-agnostic CLI that keeps developers fluent in their own codebase in the era of AI-assisted coding. It turns real code from the user's repository into small, **Verified** practice exercises (**Workouts**) that the human solves with their own brain, paying down "comprehension debt" one repair at a time.

The long-term product has several workflows (see §11). **v1 ships exactly one:** `kintsugi drill`, which takes a real piece of code, injects one realistic bug, and asks the human to find and fix it.

## 2. Principles

- **Voluntary and non-blocking.** Kintsugi never touches commits, CI, or the build.
- **Zero repo pollution.** All state lives in `.kintsugi/` at the repo root, hidden via `.git/info/exclude`. Kintsugi never edits tracked files (including `.gitignore` and `.vscode/settings.json`).
- **Language-agnostic core, native Workouts.** One orchestrator; every language-specific detail lives in a **Language Profile**. A Workout is written in the language of the source file it was derived from.
- **Standard library only.** Workouts depend on nothing but the language's standard library and built-in test runner ([ADR 0001](./docs/adr/0001-workouts-are-stdlib-only.md)).
- **Nothing unverified reaches the user.** A Workout is written to disk only if it is Verified (§6).
- **The LLM never chooses what runs.** Commands come only from Language Profiles, never from model output.
- **Secrets never live in the repo.** Code leaves the machine only with per-repo consent.
- **Generated code is untrusted.** Every Workout test run happens in an OS sandbox with no network ([ADR 0002](./docs/adr/0002-workouts-run-sandboxed-without-network.md)).
- **No telemetry.** Nothing about Kintsugi's use leaves the machine, not even opt-in ([ADR 0004](./docs/adr/0004-no-telemetry.md)).
- **Answers are measured, never asserted.** Even a Workout for people who don't read code is decided by running code ([ADR 0007](./docs/adr/0007-answers-are-measured-never-asserted.md)).
- **Called by agents, never driving them.** Kintsugi never holds AI-subscription credentials or starts an agent itself ([ADR 0005](./docs/adr/0005-called-by-agents-never-driving-them.md)).

## 3. Packaging & Requirements

| | |
| :--- | :--- |
| Package | `@<scope>/kintsugi` on npm (bare `kintsugi` is taken) |
| Binaries | `kintsugi`, alias `kin` |
| Runtime | Node.js ≥ 22.18 (native TypeScript type-stripping, flag-free) |
| Platforms | Linux and macOS; Windows via WSL only |
| Sandbox | `@anthropic-ai/sandbox-runtime`, pinned to an exact version (bubblewrap on Linux, Seatbelt on macOS) |
| Orchestrator stack | TypeScript, `commander`, `@clack/prompts`, `zod`, `execa`, `ai` (Vercel AI SDK) |
| LLM | Bring-your-own key for a cloud provider supported by the `ai` SDK |

## 4. v1 CLI

| Command | Description |
| :--- | :--- |
| `kin init` | Creates `.kintsugi/`, appends `.kintsugi/` to `.git/info/exclude`, runs the sandbox canary (§7), prints a tip on disabling AI completions inside `.kintsugi/` in your editor. |
| `kin drill <file>[#symbol] [--quick] [--no-train] [--yes] [--no-sandbox]` | Generates a Drill (Quick with `--quick`) from `<file>` (the LLM picks the most bug-worthy unit unless `#symbol` pins one), verifies it, and opens it in the runner. `--no-train` only saves it; `--yes` skips the consent prompt; `--no-sandbox` runs Workout code unsandboxed for this invocation only (§7). |
| `kin kata <file>[#symbol] [--quick] [--no-train] [--yes] [--no-sandbox]` | Like `kin drill`, but generates a Kata: one piece of the unit removed, rebuilt from a brief (§11.5). |
| `kin explore <path> [--yes] [--no-sandbox] [--no-train]` | Build a Track for a module directory (§11.3.1). |
| `kin track [<track-id>] [--no-sandbox]` | List Tracks, or show one's progress and open its next step (§11.3.1). |
| `kin share <id>... [--remote <name>]` / `kin fetch [--remote <name>] [--no-sandbox]` | Share Workouts or Tracks with the team on the `kintsugi/workouts` branch, or bring in theirs, re-verified (§11.3.2). |
| `kin map [<path>] [--json]` | Your comprehension debt by directory, or one directory's files: local and free (§11.4). |
| `kin atlas [<path>] [--markdown]` / `kin atlas build [<dir>] [--yes]` / `kin atlas search "<goal>" [--all]` | Show, build, or search the Atlas: what each folder, file, and key function is for (§11.10). |
| `kin quick [--while "<cmd>"] [--no-sandbox]` | Start the queue's best Quick Workout right away (§11.2.3); with `--while`, during a slow command (§11.6). |
| `kin train [workout-id] [--no-sandbox]` | Opens the runner on a pending Workout (picker if no id given). |
| `kin mcp` | Kintsugi's MCP server (stdio), started by your coding agent (§11.1.1). |
| `kin agent install claude [--project] [--after-tasks]` / `kin agent uninstall claude [--project]` | Install or remove the skill, `/kin-drill` command, and MCP registration for Claude Code (§11.1.1). |
| `kin discard <id>` / `kin restore <id>` | Archive a Workout (hidden from the queue, kept), or bring it back (§11.2.2). |
| `kin refill [--commit <sha>] [--background] [--yes] [--no-sandbox] [--no-train]` | Generate a Quick Drill from a commit (default `HEAD`); the hook runs it with `--background` (§11.2.4). |
| `kin auto on [--yes] [--queue-cap <n>] [--daily-limit <n>] [--ai-only]` / `kin auto off` / `kin auto status` | Turn background generation on (with consent and the git hook) or off, or show its state (§11.2.4). |
| `kin log [-n <count>]` | What background generation did (§11.2.4). |
| `kin cost [--since <date>]` | What generating Workouts has cost since a date (default: the start of this month), split into finished Workouts, Workouts not finished yet, and requests that produced nothing (§11.2.1). |

## 5. Language Profiles

A Language Profile is pure data; the only per-language code is the parser for its result format. No language-specific logic exists outside a profile.

```typescript
export interface LanguageProfile {
  id: string;
  extensions: string[];                  // matched against the drilled source file
  codeFilename: string;
  testFilename: string;
  supportFiles: Record<string, string>;  // written into every Workout, e.g. Go's go.mod
  promptRules: string;                   // language-specific generation constraints
  preflightCmd: string;                  // cheap toolchain check, run in the sandbox before any LLM call
  testCmd: string;                       // runs the tests once in the Workout directory
  resultFormat: 'tap' | 'junit-xml' | 'go-json' | 'unittest-verbose';
  resultFile?: string;                   // results file inside the Workout directory; stdout when absent
  env: Record<string, string>;           // added to the scrubbed environment, e.g. GOPROXY=off
  cacheDirs: string[];                   // env vars pointed at ~/.cache/kintsugi/<id>/<VAR>/, e.g. GOCACHE
  extraReadPaths: string[];              // sandbox allowances (never network)
  extraWritePaths: string[];
  limits?: { processMemoryMiB?: number; memoryMiB?: number; processes?: number };  // raise or lower the defaults (§7)
}
```

Every test run is normalised to:

```typescript
type TestOutcome = 'pass' | 'assertion-failure' | 'error';
interface TestRun {
  ran: boolean;                          // false on compile/syntax/import failure, missing result file, or a stop
  stopped?: 'timeout' | 'memory' | 'processes';  // why Kintsugi stopped the run (§7)
  tests: { name: string; outcome: TestOutcome }[];   // skipped tests are left out
  output: string;                        // combined runner output, for humans and LLM retry feedback
}
```

### Built-in profiles (v1)

| id | Extensions | Files | Test command | Results | Test names |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `typescript` | `.ts`, `.mts`, `.cts`, `.tsx` | `kata.ts`, `kata.test.ts` | `node --experimental-strip-types --test --test-reporter=tap kata.test.ts` | TAP | `suite > test` |
| `javascript` | `.js`, `.mjs`, `.cjs`, `.jsx` | `kata.mjs`, `kata.test.mjs` | `node --test --test-reporter=tap kata.test.mjs` | TAP | `suite > test` |
| `python` | `.py` | `kata.py`, `test_kata.py` | `python3 -m unittest -v test_kata` | unittest verbose | `Class.test_method` |
| `go` | `.go` | `kata.go`, `kata_test.go`, `go.mod` (`go 1.21`) | `go test -json .` | `go test -json` | `TestName/subtest` |

Notes:

- **TypeScript:** `--experimental-strip-types` is a no-op from Node 22.18 and keeps older 22.x working. The preflight evaluates a typed snippet, so it proves type-stripping works rather than just that `node` exists.
- **Outcome mapping:** TAP failures with `code: 'ERR_ASSERTION'` are assertion failures, other failures are errors, and a file that fails to load (a synthetic test carrying `exitCode`) means not run. unittest takes test names from the verbose lines but outcomes from the final `FAIL:`/`ERROR:` report (the verbose lines are split by docstrings and test output); no `Ran N tests` line, or a `_FailedTest`, means not run. Go has no assertion library, so `t.Error`/`t.Fatal` failures are assertion failures and panics are errors; a build failure produces no test events, which means not run.
- **Go** runs with `GOPROXY=off`, `GOFLAGS=-mod=mod`, `GOTOOLCHAIN=local`, `GOWORK=off`, and a persistent `GOCACHE`.
- **JSX** is never generated: `.tsx`/`.jsx` sources are drilled into plain functions.

Profile prompt rules include, e.g.: TypeScript uses only erasable syntax (no `enum`, `namespace`, parameter properties) and imports with explicit `.ts` extensions; Go uses `package kata` with `testing` only; Python uses `unittest` only.

### Supported languages

A language is officially supported only if its toolchain ships a built-in test runner with per-test results. Others (Java, C#, C/C++, …) are possible via user-defined profiles; adopting a single required test dependency for them would need a new ADR.

### User-defined profiles

Users may declare additional profiles (`"profiles": [...]`) in `.kintsugi/config.json` or the user-level config. They must use a machine-readable `resultFormat` (`tap` or `junit-xml`, optionally read from a `resultFile`). Their commands run in the same sandbox and may declare extra read/write paths, but never network access. A declared profile replaces a built-in one with the same id and wins for any extension it claims; repo-level declarations win over user-level ones.

## 6. The Verified Gate

No Workout is written to `.kintsugi/workouts/` unless every check passes. Each test run executes in a fresh temp directory, inside the sandbox (§7), with a 10 s timeout. All checks run and every failure is reported (not just the first), so a retry learns everything that was wrong.

1. **Reference passes:** running the tests against the Reference Solution: `ran` is true and every test is `pass`.
2. **Starting Code fails meaningfully:** running the tests against the Starting Code: `ran` is true, at least one test is `assertion-failure`, and at least one test is `pass`. No test may be `error`.
3. **Drill only:** the Regression Test is among the `assertion-failure`s. Its name must match exactly one test, either exactly or as the trailing segment(s) of the test's path (`starves late jobs` matches `scheduler > starves late jobs`; `test_x` matches `Class.test_x`).
4. **Minimal diff:**
   - *Drill:* Starting Code differs from the Reference Solution in one contiguous region of ≤ 3 changed lines (the larger of lines removed and lines added).
   - *Kata:* Starting Code is the Reference Solution with exactly one region replaced by a gap of ≤ 3 placeholder lines; for a Quick Workout the removed region is 5–12 lines. (Katas aren't generated in v1, but the rule is part of what Verified means.)
   - The comparison is a line diff that ignores line endings, trailing whitespace, and trailing blank lines.

**On failure:** retry generation up to 2 more times, feeding each failing check and its test output (the last 4,000 characters) back to the LLM. If the third attempt fails, report `Couldn't produce a Verified Workout from <target>` and write nothing.

## 7. Sandbox

All Workout code (verification and runner alike) is untrusted: users drill code they didn't write, and text in that code can steer the LLM (prompt injection). See [ADR 0002](./docs/adr/0002-workouts-run-sandboxed-without-network.md).

**Threat model:** in scope are accidents (destructive writes, runaway loops, fork bombs, memory exhaustion) and prompt injection leading to exfiltration or damage. Out of scope: a malicious local user or config.

**Policy** (every test run):

| Resource | Rule |
| :--- | :--- |
| Network | Fully denied. Go runs with `GOPROXY=off`, `GOFLAGS=-mod=mod`. |
| Writes | Only the Workout directory and the profile's cache dirs under `~/.cache/kintsugi/<profile>/` (persistent, per user, for speed). |
| Reads | Allowed, except `~/.ssh`, `~/.aws`, `~/.config`, `~/.gnupg`, `~/.netrc`, and the **entire repository** (Workouts never need it, and it may hold `.env` files, credentials, or state files). The Workout directory is re-allowed even when it lives inside the repo. |
| Environment | Empty, plus an allowlist: `PATH`, `LANG`, `HOME` and `TMPDIR` (pointed at per-run scratch dirs), and the profile's `env` / `cacheDirs`. No API keys or tokens ever reach Workout code. |
| Resources | 10 s wall-clock timeout; at most 1 GiB per process (`RLIMIT_DATA`); at most 2 GiB in total and 256 processes across the command's whole process tree (a watchdog); a process-count backstop at the user's current task count + 2,048 (`RLIMIT_NPROC`). Output is capped at 1 MiB per stream. See *Resource limits* below. |

**Resource limits.** The bar is that the user's machine stays responsive: a runaway Workout (buggy or prompt-injected) is stopped well before it swaps or freezes the machine, and the user is told why. Three layers sit on top of the timeout (which already kills the whole sandbox: bubblewrap runs it in its own PID namespace):

1. **Per-process memory:** `ulimit -d` (`RLIMIT_DATA`, 1 GiB) caps what any single process can allocate. Unlike `ulimit -v`, it doesn't count the large address-space reservations V8 and Go make, so ordinary tests are unaffected. Likely not enforced on macOS (to confirm during the macOS check).
2. **Process backstop:** `ulimit -u` (`RLIMIT_NPROC`) at the user's current task count + 2,048. The kernel counts all of the user's processes (and, on Linux, threads), not just the command's, so this is only a coarse wall against fork bombs; a tight value breaks the sandbox itself.
3. **Watchdog:** every 250 ms Kintsugi reads the command's process tree (`ps`, the same on Linux and macOS) and kills it if the tree holds more than 2 GiB resident memory or more than 256 processes. Short-lived bursts between samples are left to layers 1 and 2.

The limits apply to every run, including under `--no-sandbox` (which only drops isolation). The command can't lift them (they're set as hard limits). A Language Profile can raise or lower them (`limits: { processMemoryMiB, memoryMiB, processes }`) but not switch them off. A run stopped by the timeout or the watchdog counts as not run, with `stopped: 'timeout' | 'memory' | 'processes'` and a plain message ("Stopped: the tests used more than 2 GiB of memory. Look for a runaway loop or allocation."), shown in the runner and fed back to the LLM on retry. A process killed by the per-process cap fails with its runtime's own out-of-memory error instead.

*Rejected:* cgroups via `systemd-run --user`. On WSL with hybrid cgroups, `MemoryMax` and `TasksMax` were accepted and silently not enforced (512 MiB passed a 150 MiB limit; 40 processes passed a limit of 20), which is worse than no limit.

All execution goes through one internal `Sandbox` interface; `@anthropic-ai/sandbox-runtime` is the v1 implementation and can be swapped.

**Canary:** `kin init` (always fresh) and the preflight (cached for a week per platform, Node version, and sandbox-runtime version) run a canary inside the sandbox that tries to open a network connection, write outside the Workout directory, read a planted secret and every existing secret path above, and read a scrubbed env var. All must be refused. Two more probes, under deliberately low limits, must be stopped for the right reason: four processes holding ~600 MiB against a 256 MiB total, and a loop starting 100 processes against a limit of 32. A write inside the Workout directory must succeed (so a canary that can't run at all never counts as a pass); otherwise the sandbox is treated as unavailable.

**Unavailable sandbox:** Kintsugi refuses to run Workout code and prints install instructions (Linux: `bubblewrap`, `socat`, `ripgrep`; macOS: `ripgrep`). `--no-sandbox` overrides for that single invocation and is never persisted. Environment scrubbing applies regardless.

## 8. Generating a Drill

1. **Resolve target:** pick the Language Profile by file extension; error if none matches.
2. **Preflight:** check the sandbox (canary, cached) and run the profile's `preflightCmd`; on failure, stop with a clear message (no tokens spent).
3. **Consent:** on the first generation in a repo (and again whenever the provider changes), show the file that will be sent and the provider, ask `Send code to <provider>? [y/N]`, and remember a yes in `.kintsugi/config.json`. `--yes` grants it without asking; with no terminal to ask in and no `--yes`, Kintsugi refuses. The API key is resolved before any of this, so a missing key fails fast.
4. **Synthesize:** send the target, with numbered lines (and `#symbol` if given), to the LLM with the Drill prompt (§9).
5. **Verify:** run the Verified gate (§6), with retries.
6. **Persist:** write the Workout (§10), stamping Source Anchors with the current commit SHA.
7. **Train:** open the runner (§10) unless `--no-train` or there is no terminal, in which case `kin drill` prints the README, the code file, and `kin train <id>`.

Progress is shown as steps in the foreground throughout (expect ~30–120 s).

## 9. LLM Output Schema & Drill Prompt Rules

The model answers with structured output (`generateText` + `Output.object` from the AI SDK) against `DrillOutputSchema` (`src/synthesis/schema.ts`):

| Field | Notes |
| :--- | :--- |
| `worthPracticing`, `notWorthReason` | When false, every other field is left empty. |
| `slug`, `title`, `pillar`, `estimatedMinutes` | `pillar` is `algorithm` \| `pattern` \| `library`. |
| `sourceAnchors[]` | `{ startLine, endLine, explanation }` against the numbered source shown in the prompt. |
| `readmeMarkdown` | The incident report. |
| `hints` | Exactly 2. |
| `startingCode`, `referenceSolution`, `testSuiteCode` | Complete files. |
| `regressionTestName`, `injectedBugDescription` | The Regression Test and the internal note on the bug. |

The schema itself carries only types, enums, and descriptions, because providers' structured output support for numeric, length, and pattern constraints varies. The remaining rules (kebab-case slug ≤ 48 chars, 2–15 minutes, exactly 2 hints, anchors within the file, no empty fields) are checked afterwards and, like Verified-gate failures, fed back as retry feedback (`[schema] …`). A response that isn't valid JSON for the schema is also retried; API errors (auth, quota, network) are not.

**Model settings.** Anthropic requests on Claude Opus 5+, Fable 5+, and Sonnet 5.5 use adaptive thinking, `effort: 'high'`, and server-side refusal fallbacks (`fallbacks: 'default'`); other models and providers get their defaults. `maxOutputTokens` is 32,000.

**Retries** continue the same conversation: the model's previous answer (including its reasoning parts) stays in the history, followed by the verifier's findings, so it never loses what it tried.

**Source size.** Files over 3,000 lines are refused with a request to move the unit into a smaller file, rather than truncated.

If `worthPracticing` is false, Kintsugi reports the reason and stops (no retry).

**Drill prompt rules**

- Extract one unit from the target and make it self-contained in a single code file; replace infrastructure (DB, network, filesystem, clocks, queues) with small inline fakes.
- Standard library and built-in test runner only; obey the profile's `promptRules`.
- Inject exactly **one** realistic, subtle bug in a single region of ≤ 3 lines, from one of:
  - *Algorithmic boundary:* off-by-one, inverted tie-breaker, unbounded loop on cyclic input, float drift.
  - *Concurrency / async:* check-then-act race, missing `await` in a loop, leaked timer/listener.
  - *State / mutation:* in-place mutation of caller data, shallow-copy aliasing, swallowed error.
- No comments that point at the bug.
- All tests are visible to the human. The Regression Test is **named and described by observable symptom only**, never by cause.
- `readmeMarkdown` is written as a 3 AM incident report: *Symptom*, *Mission* ("make all tests pass without changing function signatures"), and Source Anchors. Hints are **not** in the README.

## 10. Workspace & Runner

### Layout

```text
target-repo/
├── .git/info/exclude              # contains `.kintsugi/`
└── .kintsugi/
    ├── config.json                # provider, model, consent, user-defined profiles (no secrets)
    ├── state.json                 # outcomes log
    ├── workouts/
    │   └── drill_20261023_redis-lock/
    │       ├── README.md
    │       ├── kata.ts
    │       ├── kata.test.ts
    │       ├── workout.json       # hints, regression test, bug note, anchors (with commit), metadata
    │       └── .solution/         # Reference Solution and the original tests: out of the way, not secret
    └── attempts/
        └── drill_20261023_redis-lock/
            └── 1/                     # a fresh copy of the code, tests, and support files; attempt.json (runs, Hints, outcome, rating)
```

API keys come only from environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or the user-level config at `~/.config/kintsugi/`. Never from `.kintsugi/`.

### Runner (`kin train`)

- `kin drill` opens the runner on the new Workout when run in a terminal (unless `--no-train`); `kin train` with no id picks among pending Workouts (newest first), and needs an interactive terminal.
- Prints clickable paths to `README.md` and the code file, and opens them in `$VISUAL` if set (spawned detached, so it should be a GUI editor).
- Watches the Workout directory itself (language-agnostic) and re-runs `testCmd` (sandboxed) whenever a file's *content* changes, ignoring `README.md`, `workout.json`, `.solution/`, the result file, and editor temp files. Runs never overlap: a save during a run queues one more.
- Shows per-test results with each failure's message (the assertion text, traceback, or `t.Error` output); when a failure has no message, the tail of the runner output instead.
- If the source file has changed since the anchored commit, shows: *"Source has changed since this Workout was made."*
- Keys:
  - `[h]` reveals the next Hint (counted).
  - `[g]` gives up: shows the diff against the Reference Solution and marks the Workout **Abandoned**.
  - `[q]` quits, leaving the Workout pending.
  - Ctrl+C behaves like `[q]`.
- When every test passes against the original tests, the Workout is **Completed**. If the test file was edited (compared with `.solution/`), passing doesn't count and the runner says so.
- On Completed or Abandoned, asks *"Was this a good Workout? [y] 👍 [n] 👎"* (any other key skips) and finishes the Attempt (§11.2.2). The Workout stays where it is and can be redone.

### `state.json`

```json
{
  "outcomes": [
    {
      "workoutId": "drill_20261023_redis-lock",
      "outcome": "completed",
      "at": "2026-10-23T11:42:00Z",
      "attempts": 4,
      "hintsUsed": 1,
      "rating": "up"
    }
  ]
}
```

`state.json` also holds the **spend ledger** (`"spend": [...]`): one entry per `kin drill` request that reached the model, with its `result` (`verified`, `not-verified`, `not-worth-practicing`, `error`), the Workout id if one was saved, the number of generation attempts, and its `cost` (usage per model, estimated dollars, unpriced models, and the price table's date).

`attempts` counts test runs triggered by saves (not the initial run). `hintsUsed` counts Hints revealed. Ratings are local only and exist to tune prompts. Leaving with `[q]` records nothing.

## 11. Release Plan

### 11.1 Before v1.0 (release blockers)

*v1.0.0 was tagged on 2026-10-23 with the package still private. Carried over as open items: your ratings of dogfooded Drills (generation side done: 16 Drills, every real target Verified, spoiler fix applied), the macOS and native Linux sandbox check, and choosing an npm scope.*

1. **Dogfooding milestone.** About 10 real Drills across ≥ 3 languages in ≥ 2 real repositories, logging generation attempts, cost, and ratings, then a review. v2's plan may change on what it shows (Verified rate, cost per Drill, subtlety). With agent mode (§11.1.1) it can run on an existing coding-agent subscription at no API cost.
2. ~~**Cost recording** (§11.2.1).~~ Done.
3. **npm scope** chosen; `"private": true` removed.
4. ~~**Sandbox resource limits**~~ Done (§7 *Resource limits*).
5. **Sandbox verified** on macOS and native Linux (so far only WSL), including whether `RLIMIT_DATA` is enforced on macOS.
6. ~~**Agent mode**~~ Done (§11.1.1).

### 11.1.1 Agent mode (implemented in v1.0)

Generate Workouts with the user's own coding agent instead of an API key ([ADR 0005](./docs/adr/0005-called-by-agents-never-driving-them.md)): Kintsugi is *called by* the agent, never drives one. Everything after generation (the Verified gate, the sandbox, saving, the runner) is unchanged.

- **No mode switch.** `kin drill` generates through the API; the agent generates through the MCP tools. With no API key, `kin drill` suggests the agent ("run `kin agent install`, then ask it to `/kin-drill src/queue.ts`").
- **`kin mcp`**: a local (stdio) MCP server for any MCP client, working in the git repository containing its working directory. Tools:
  - `prepare_drill(target, { quick?, afterTask? })` returns a generation id, the same system prompt and numbered source API mode sends, and `DrillOutputSchema` as JSON Schema.
  - `submit_drill(id, workout)`: the input schema *is* `DrillOutputSchema`. Runs `checkDrillOutput` and the Verified gate in the sandbox, and returns the saved Workout's id or the same retry feedback API mode uses. At most 3 submissions per generation id, then "start over with `prepare_drill`".
  - `list_workouts`.
- **Boundaries.** Targets follow `kin drill`'s rules (inside the repository, not in `.kintsugi/`). Workout code never runs unsandboxed: there is no `--no-sandbox` equivalent, and with no working sandbox `submit_drill` returns the install instructions. The server never prompts. There is no consent step: Kintsugi sends nothing anywhere; the agent already has the code.
- **Guidance.** The essential rules live in the MCP server's instructions and tool descriptions, so every client gets them (prepare before submitting; fix every reported problem; never edit files under `.kintsugi/`; stop after a refusal).
- **`kin agent install claude`** (Claude Code first; other MCP clients run `kin mcp` as a stdio server) installs at user level by default (`~/.claude/skills/kintsugi/SKILL.md`, `~/.claude/commands/kin-drill.md`, `claude mcp add --scope user`; the end-of-task block goes in `~/.claude/CLAUDE.md`). With `--project`: `.claude/…` and `CLAUDE.local.md` in the repository, untracked and excluded, never overwriting a tracked file, and `claude mcp add --scope local`. Re-running replaces the previous installation; `kin agent uninstall` removes exactly what was added (only files carrying Kintsugi's stamp, and only the marked block). Without the `claude` CLI, the registration command is printed to run by hand. It installs: a skill (choosing a unit worth drilling while exploring, delegating generation to a subagent so the user's working context stays clean, never revealing the bug, pointing to `kin train <id>`, offering Hints rather than fixes when asked for help on a Workout), a thin `/kin-drill` command invoking it, and the MCP registration (`claude mcp add --scope user`). `--project` writes them into the repository instead, untracked and hidden through `.git/info/exclude`. The files are generated from text embedded in `kin`, stamped with its version; `kin mcp` warns when they're older than itself.
- **`--after-tasks`** (opt-in) adds a marked block with an instruction to generate a Quick Drill about what the agent changed when it finishes a task: Origin `agent-task`, subject to the v2 queue caps (`submit_drill` refuses when the queue is full or the source file already has a queued Workout from an agent task).
- **Recording.** Each Workout records its **Generator** (`kintsugi` or `agent`) next to its Origin. Agent-generated requests enter the spend ledger with cost "not measured" (never $0: they used the agent's plan); `kin cost` lists them separately; the README says "Generated by your coding agent".
- **Not in v1.0:** an IDE "Socratic coach" rule (part of the deferred Socratic coach), installers for agents other than Claude Code.

### 11.2 v2: Habit and automation

*v2.0.0 was tagged on 2026-10-27, package still private. Verified on real repositories: commit selection, `kin auto` with a real commit and hook, `kin quick`. Not yet run for real: background generation through the API (no API key was available; the same pipeline is covered by mock-model tests and `kin drill`). Still open from v1.0: Drill ratings, the macOS and native Linux sandbox check, the npm scope.*

Turn Drills into a habit: Workouts are pre-generated from your commits in the background, and `kin quick` serves one instantly during the waits of agent-driven work. Out of scope for v2: `--while`, Katas.

#### 11.2.1 Cost visibility (implemented in v1.0)

- Every LLM call's usage is recorded: input, output, and cached tokens, and the model that actually answered (a refusal fallback may switch models).
- Dollars are **estimates** from a price table built into each Kintsugi release, overridable per model in config. A model with no known price shows tokens only, marked "cost unknown".
- A Workout's cost is the sum of **all** its generation attempts, including rejected ones. It is stored in `workout.json` and shown in its README ("Generated for ≈ $0.38 over 2 attempts"), the runner's header, and the `kin train` picker.
- A **spend ledger** in `state.json` records every generation, including those that produced no Workout (not Verified, not worth practicing).
- **`kin cost [--since <date>]`** (default: this month) splits spend into: Workouts attempted; Workouts never attempted, including Discarded ("money left on the table"); generations that produced nothing; and background versus manual. Until Attempts exist (§11.2.2), v1 splits Workouts into *finished* (Completed or Abandoned) and *not finished*.
- A failure partway through (e.g. the provider is overloaded on a retry) still records what the earlier calls cost, with `result: "error"`.
- No estimate is shown before generating. Once the ledger has history, `kin drill` and `kin auto on` show "your Drills have averaged $X (last N)".

#### 11.2.2 Workouts and Attempts (implemented)

Per [ADR 0003](./docs/adr/0003-workouts-are-immutable-attempts-hold-outcomes.md):

- A **Workout** (`.kintsugi/workouts/<id>/`) is an immutable, Verified definition; it never moves or changes. `done/` goes away.
- An **Attempt** is one try at a Workout, in a fresh copy at `.kintsugi/attempts/<workout-id>/<n>/`. Outcomes (Completed, Abandoned), Hints used, and **runs** (test runs triggered by saves; v1's `attempts` counter) belong to the Attempt. Finished Attempts are kept, with the human's final code.
- At most one open Attempt per Workout: `kin train <id>` resumes it (with its code, runs, and Hints used), or starts a new one. Redoing a Workout is always explicit; `kin train` with no id offers open Attempts first, then the queue.
- The runner watches the Attempt directory, reads the incident report and Reference Solution from the Workout, and treats the test file as edited when it differs from the Workout's own (never-edited) test file.
- **Discarded** is a Workout-level state meaning archived: hidden from the queue and not counted against its cap, but kept and restorable (`kin discard <id>`, `kin restore <id>`). It is recorded in `state.json` (`"discarded": { "<id>": { "at", "reason" } }`); the Workout's files don't move. Workouts from commits expire into it after 14 days (configurable).
- v1 data: pending v1 Workouts become v2 Workouts as they are. v1's `done/` is left in place and ignored (with a one-line notice): v1 edited Starting Code in place, so a worked-on v1 Workout's original Starting Code can't be recovered. (The package was never published; only dogfooding data is affected.)

#### 11.2.3 The queue and `kin quick` (implemented, except where noted)

- The **queue** is the Workouts that have never been attempted and aren't Discarded: one pool for manual and background Workouts. Each Workout records its **Origin**: `manual` or `commit:<sha>`.
- **`kin quick`** picks the best queued **Quick** Workout (from AI-written code first: agent tasks, and AI-authored commits once phase 3 lands; then newest; skipping any whose source file no longer exists) and opens the runner at once: no picker, no prompts, and it exits when done. With nothing ready, it says how to make one; offering `kin refill` in the foreground arrives with phase 3. There is no uncommitted-diff fallback.
- **Quick** is enforced mechanically: `estimatedMinutes ≤ 5` and Starting Code ≤ 60 lines, as `[schema]` retry feedback. Workouts from commits are always Quick; manual ones with `kin drill --quick` (or `quick: true` in agent mode). The queue judges Quick by the same numbers, so any small enough Workout qualifies however it was requested.

#### 11.2.4 Background generation from commits (implemented)

- **Opt-in only.** `kin auto on [--yes] [--queue-cap <n>] [--daily-limit <n>] [--ai-only]` asks one consent covering background spending, its caps, and sending the changed file to the provider (with your average cost per Drill once there is history), records it in `.kintsugi/config.json` (`auto` plus the send-code `consent`), and installs the hook. `kin auto off` removes exactly what Kintsugi added. `kin auto status` shows on/off, today's budget used, the queue size, and the latest failures. `kin init` never enables it, only mentions it.
- **The hook.** `.git/hooks/post-commit` (untracked): written if absent, otherwise a clearly marked block is appended and the user's lines are never rewritten. With `core.hooksPath` set (husky, lefthook), Kintsugi prints the snippet to add instead of editing tracked files. The hook only starts `kin refill --background --commit <sha>` detached (`nohup`, absolute paths to `node` and `kin`, git's commit-time variables such as `GIT_INDEX_FILE` cleared first); the commit never waits. `kin auto off` keeps custom caps for next time. `kin refill` can also be run by hand.
- **Which commits.** Every commit by you is a candidate; commits with known AI `Co-Authored-By` trailers (Claude, Copilot, Cursor, …) get priority, and config can restrict generation to them. Skipped before any LLM call: merges; commits made mid-rebase or mid-cherry-pick; other authors' commits; commits touching only docs, config, lockfiles, tests, generated or vendored code; tiny diffs (fewer than 5 changed lines in the chosen file); bulk changes (more than 300 changed lines in the chosen file: an initial commit or a large refactor is not one focused change; drill a part of it with `kin drill <file>#<symbol>`).
- **What a commit becomes.** At most one Drill: among changed files a Language Profile recognises (minus tests, generated, and vendored paths), the one with the most changed lines. The model gets that file as of the commit plus its diff, and builds the Drill around the change.
- **No paying twice.** At most one queued Workout from commits per source file; the backlog collapses entries for the same file.
- **Caps.** Nothing is generated while the queue holds 3 Workouts, and at most 5 generations (retries included) run per day. Both are configurable. The queue cap counts every waiting Workout, whatever made it (the cap exists to stop spending on Drills that pile up unsolved), so `kin auto on` and `kin auto status` say plainly when generation is *paused* because the queue is full, and how to resume it (attempt or `kin discard` a Workout, or raise the cap).
- **`kin refill [--commit <sha>]`** (default `HEAD`): run by hand it behaves like `kin drill` (may ask consent, ignores the caps, opens the runner); `--background` (what the hook runs) never prompts, needs `kin auto on` and consent, and obeys the caps. Commits already turned into a Drill or permanently skipped are remembered (`state.json` → `refill.processed`) so nobody pays twice; cap-related skips are *deferred*, not remembered, so a later `kin refill` can still use the commit. When fewer than 3 generations are left for the day, the generation gets only that many attempts, so the limit is never overshot. The Drill's Source Anchors are pinned to the commit it came from.
- **Running unattended.** Never prompts. A per-repo lock allows one generator at a time; commits arriving meanwhile join a backlog that keeps the newest 5. With no consent, no `kin auto on`, or no API key, it skips and logs. Results go to `.kintsugi/log` (one JSON line per outcome: generated, skipped, deferred, not-worth-practicing, failed; `kin log` prints them); the next `kin quick`/`kin train` shows a one-line summary of background failures not yet shown. `kin quick` with nothing ready offers to run `kin refill` in the foreground. Stale commit Workouts are expired (Discarded) when `kin refill` or `kin quick` runs. Docs recommend keeping the API key in the user config, since commits made from GUI tools may not see shell environment variables.

### 11.3 v3: Onboarding and team sharing

*v3.0.0 was tagged on 2026-10-28, package still private. Verified for real: two Tracks built by headless Claude Code (agent mode) on clew and N4List, and a Track shared and fetched through a scratch remote. Not yet run for real: `kin explore` in API mode (no API key; covered by mock-model tests). Still open from v1.0: Drill ratings, the macOS and native Linux sandbox check, the npm scope.*

For the **newcomer to a codebase** (a new hire, a contributor, a future you): someone who knows the code generates a Track once; teammates reuse it without paying again. Out of scope for v3: `kin map` (it needs practice history first) and Katas (Tracks are Drills only).

#### 11.3.1 `kin explore` and Tracks (implemented)

- **`kin explore <path>`** builds a **Track** for the module at `<path>` (a directory): 3 to 5 Drills, each from a different file, ordered **foundations first** (the code the rest depends on before the code that orchestrates it). Each step carries its pillar as a label and a one-line *why this matters for the module*. No fixed per-pillar template.
- **Choosing the steps.** A static, language-neutral pass shortlists about 10 candidate files (size, branching density; tests, generated, and vendored files excluded). One inexpensive LLM call sees their paths and outlines, picks 3 to 5, orders them foundations first, and writes the *why* lines.
- **Generation is up front**, after showing the estimated cost (steps × the recent average cost per Drill) and asking for confirmation. A step that can't be Verified is replaced by the next shortlisted file.
- **Agent mode.** The agent replaces the ordering call: `prepare_track(module)` returns a track id, the static shortlist (paths with sizes and outlines), and the same ordering rules; the agent creates each step, in Track order, with `prepare_drill` / `submit_drill`, passing `{ trackId, why }` (a step must be a shortlisted file not already in the Track, at most 5 steps); a step that ends without a Drill is recorded as dropped; `finish_track(trackId, title)` writes the Track once it has at least 3 Verified steps, in the order they were saved. With fewer it reports what failed and saves no Track; the Verified Drills remain ordinary Workouts. Because the agent names the Track only at the end, its Drills' READMEs say *Part of a Track on `<module>`: why*. The skill's description now also triggers on requests to learn, explore, or onboard onto a module; the skill delegates the whole Track to a subagent.
- **Track Drills** have Origin `explore`: they stay out of `kin quick`, out of the background queue cap, and never expire. Each records its Track (`workout.json` → `track`) and its README opens with *Part of the Track "…": why*; step order lives only in the Track's manifest (`.kintsugi/tracks/<track-id>.json`), since a dropped step would make a number in an immutable Workout wrong for good.
- **Recording.** The ordering call's cost enters the spend ledger with `result: "track-plan"` (`kin cost` shows a *Planning Tracks* line). The ordering call also returns up to 3 alternates, best first, each with its *why*: a step that can't be Verified (or isn't worth practicing) is replaced by the next alternate in the same position. `kin explore` needs a module directory with at least 3 eligible source files (15 to 3,000 lines; tests, generated, and vendored files excluded).
- **`kin track [<track-id>]`** shows a Track's progress step by step and opens the next unattempted step with the usual runner and Attempts.

#### 11.3.2 Team sharing (implemented)

Per [ADR 0006](./docs/adr/0006-workouts-shared-on-a-dedicated-branch.md), Workouts are shared on a dedicated `kintsugi/workouts` branch, reaching exactly the people who can read the repository.

- **Explicit.** `kin share <id>... [--remote <name>]` publishes Workouts or Tracks (a Track with all its steps); `kin fetch [--remote <name>] [--no-sandbox]` brings in what teammates shared. Generating never publishes on its own.
- **Layout.** The branch holds `workouts/<id>/…` (each Workout's definition files) and `tracks/<track-id>.json`. Locally Kintsugi keeps its copy in a hidden ref, `refs/kintsugi/workouts`, so no local branch appears. Content is compared by a fingerprint of the definition files that ignores `workout.json`'s `id` and `sharedBy`, so sharing or fetching the same Workout again is a no-op, and a renamed import is recognised next time. Fetched files are staged inside `.kintsugi/` and moved into place only after they re-verify; fetched Track manifests are remapped to the steps' local ids.
- **Only definitions travel:** incident report, Starting Code, tests, Reference Solution, Hints, Source Anchors, `workout.json` (cost included), and Track manifests, each stamped with who shared it (git `user.name` and `user.email`). Attempts, `state.json`, the spend ledger, and config never leave the machine.
- **The branch.** Kintsugi writes it with git plumbing: the user's working tree, index, and current branch are never touched. It pushes to `origin` (configurable). If the push is rejected because a teammate pushed first, it fetches, unions both sets (each Workout is its own folder), and pushes again. A fetched Workout with the same id as a local one but different content is imported under a suffixed id; identical content is a no-op. Docs note that pushing a new branch can trigger CI on some setups.
- **Re-verified on fetch.** Each incoming Workout runs through the Verified gate in the local sandbox (no LLM); failures (toolchain differences, corrupted or tampered files) are skipped and reported.
- **What can't be shared.** `kin share` refuses Workouts made from uncommitted code, and warns (but shares) when the anchored commit isn't on any remote branch yet ("push your branch so teammates' source links work").
- **In the queue.** Fetched Workouts become *queued* for the recipient, keep their Origin, and count toward the background queue cap (unsolved Drills are unsolved, whoever generated them); fetched Track Drills don't. Expiry applies only to the user's own background Drills, never to fetched or Track ones.

### 11.4 v3.1: `kin map` (implemented)

**Your** comprehension debt in this repository, at a glance. Built only from your Attempts, git history, and the shortlist's complexity score: purely local, no LLM calls, free to run as often as you like. Practice data never leaves the machine, so there is no team view.

- **`kin map [<path>] [--json]`**: a coloured tree of directories (each with its counts, e.g. `●2 ◐3 ✓5`, coloured by its worst file); with a path, that directory's files. `--json` gives the same data for scripts and editors. Only tracked files a Language Profile recognises appear; grey files are left out of directory counts and shown dimmed when drilling in.
- **Practised:** a file is Practised once you've finished an Attempt on any Workout made from it (manual, commit, agent, Track, or fetched). Completed shows ✓, Abandoned ~; both count.
- **Stale:** your practice on a file is Stale when the file has changed by 20 or more lines (`git diff --numstat <commit> -- <file>`, working tree included) since the commit the most recently practised Workout was made from.
- **States, worst first:**
  - ● **red:** never Practised, and in the repository's top quarter by logic density (the shortlist's score, repo-wide).
  - ◐ **amber:** Practised but Stale, or never Practised, at or above the repository's median logic score, and changed in the last 30 days by AI-authored commits. (Without the median floor, a repository written mostly with AI agents turned half amber, which says nothing: measured on real repositories, 37 of 50 and 66 of 88 drillable files, versus 12 and 22 with it.)
  - ✓ **green:** Practised and not Stale.
  - · **grey:** never Practised and below those thresholds (including AI-changed glue below the median), or not drillable (tests, generated code).
- **Suggestions** (at most 3, in this order): a Workout already waiting (queued or in progress) for a red or amber file → `kin train <id>`; a directory with several red files → `kin explore <dir>`; a single red or amber file → `kin drill <file>` (or `/kin-drill`).

### 11.5 v3.2: Katas (implemented)

*Covered by mock-model tests; not yet generated by a real model.*

A **Kata** trains *writing*: rebuild a missing piece of logic from its contract and its tests (a Drill trains *reading*: find what's wrong). It is the "can I still write this myself?" skill that AI-assisted work erodes fastest.

- **Entry points.** `kin kata <file>[#symbol] [--quick] [--yes] [--no-sandbox] [--no-train]`, alongside `kin drill`; in agent mode `prepare_drill` takes `kind: 'kata'` (no new tools; `/kin-drill <file> kata` asks for one, and a Track step asked for as a Kata is refused). Katas appear only when asked for: background commit Workouts and Tracks stay Drills until Katas have been dogfooded. `kin quick` serves a Quick Kata like any Quick Workout (it picks by size, not kind).
- **The gap.** One contiguous region of 5 to 25 lines (5 to 12 for a Quick Kata), ideally one function body or one cohesive block, replaced by at most 3 placeholder lines that return a type-correct but wrong value with a `TODO` (`return 0`, `return []`, `return None`, Go's zero value), so tests fail by assertion and the Verified gate needs no exception for Katas.
- **Tests.** Most pin down the gap's contract, edge cases included; at least one exercises code outside the gap, so something passes against the Starting Code.
- **The brief** (README): *What it must do* (the missing unit's contract, inputs and outputs, the edge cases that matter), *Where it fits* (one line on its role in the original), *Mission* (make all tests pass without changing function signatures). Two Hints, gentle first; tests visible; Reference Solution in `.solution/`.
- **Output schema.** `KataOutputSchema` shares the Drill's common fields (slug, title, pillar, minutes, Source Anchors, README, Hints, Starting Code, Reference Solution, tests), drops the Regression Test and bug note, and adds `gapSummary`: an internal note on what was removed and what a correct fill must do, never shown.
- **No answers in the brief.** Any line of the removed region with at least 15 characters (trimmed) that appears verbatim in the README or Hints is `[schema]` retry feedback.
- **Everywhere else** Katas are Workouts like any other: the runner's header says *Fill in:* instead of *Fix the bug in:*; practising one counts toward the file in `kin map`; cost and the ledger, Attempts, sharing, and re-verification on fetch follow `workout.json`'s `kind`. Kata ids start with `kata_`.

### 11.6 v3.3: `kin quick --while` (implemented)

Practice in time already lost: a slow build or test run.

- **`kin quick --while "<cmd>"`** runs `<cmd>` through the user's `$SHELL -c` (`/bin/sh` if unset) from the current directory, in the background, and serves the queue's best Quick Workout meanwhile. The command is the user's own, not Workout code: it runs exactly as if typed, with the full environment and no sandbox (ADR 0002 covers Workout code only; `--no-sandbox` still applies only to the Workout's tests). Its stdin is `/dev/null`, so a command that prompts fails instead of hanging.
- **Output** goes to `.kintsugi/while/last.log` (overwritten each time), never into the runner. Its path is printed at the start and the end; the last 20 lines are shown when the command fails.
- **Status** is event lines, not a redrawn bar: a notice at the start; the moment the command ends, a line with a terminal bell (`✓ npm test finished in 3m02s`, or `✗ npm test failed (exit 1) after 41s` and the log tail); and an `[s]` key in the runner, while a command is attached, for the elapsed time and the last lines of the log.
- **The command finishes first:** the Workout carries on; nothing is cut off. `[q]` leaves the Attempt open as usual.
- **The Workout finishes first:** with another Quick Workout ready, "Another Quick Workout while `npm test` runs? [y]"; otherwise (or on any other key) Kintsugi waits for the command, showing the elapsed time, then reports it.
- **Interrupting:** `[q]` and Ctrl+C in the runner leave the Workout and never touch the command. `[q]` or Ctrl+C while waiting for the command afterwards stops it (SIGINT to its process group, SIGKILL 5 s later). If Kintsugi fails mid-way (a sandbox error, say), it reports the error and still waits for the command.
- **Exit code:** `kin quick --while` exits with the command's exit code (128 + the signal number when it was stopped by one), so `kin quick --while "make" && ./deploy` behaves like `make && ./deploy`.
- **Nothing to serve** (no Quick Workout ready, no interactive terminal, or no Kintsugi workspace in this repository): the command runs in the foreground with its output passed through and its exit code returned, plus at most one dim note. No generation is offered: Kintsugi never stands between the user and their command, so an alias like `t='kin quick --while "npm test"'` is safe anywhere.
- Only `kin quick` takes `--while` for now.

### 11.7 v3.4: Real bugs (implemented)

*Verified for real on 2026-10-29 with headless Claude Code (agent mode) on five functions of an SSTorytime Python file, all Verified on the first submission. Both `NormalizeContext` Drills used the real bug and were reported with evidence `both`. `FormatSQLArray` got a model-only report of a different, genuine bug (an empty list raises `UnboundLocalError`). The two controls, `NChannel` and `ParseSQLLinkArray`, reported nothing. Nothing leaked into the READMEs, Hints, or Starting Code. Not yet run for real: the end-of-Attempt notice and question in an interactive terminal (covered by tests), and API mode.*

Sometimes the bug a Drill "injects" is already in the developer's code. While making the unit self-contained, the model carries the original's faulty logic into the Starting Code and writes a corrected Reference Solution. This came up in dogfooding: a Python `NormalizeContext` joins sorted tags with `if index < len(part)-1:` (the tag's length, not the number of tags), so `["a", "b", "c"]` gives `"abc"`. The Drill rewrote the code around that line (`sorted(set(...))` instead of a dict) but kept the comparison, and its Reference Solution compared with `len(unique)`. Nothing flagged it: the Verified gate compares the Starting Code with the Reference Solution, never with the source.

Kintsugi now **notices such a bug and reports it after the Attempt**. It doesn't go looking for them. Choosing units because they look buggy would turn comprehension practice into an LLM bug-finder, and extraction (fakes for clocks and I/O, renamed variables) makes false positives easy. Whether to aim for them is decided later, on the precision measured below.

- **Two signals.**
  - *Source match* (Drills only, deterministic). Split the Verified gate's single changed region (§6, check 4) into its Starting Code side (the buggy lines) and its Reference Solution side (the fixed lines), and normalize every line. A line is *significant* when it is at least 8 characters long once normalized, so `}`, `else:`, and `return` never match on their own. The source matches when every significant buggy line equals some normalized line of the source file as sent to the model, the buggy side has at least one significant line, and no significant fixed line appears in the source. A bug that only removes lines (a dropped `await`) has no buggy side, so it never matches here.
  - *Model report.* A new common output field, `originalDefect: { startLine, endLine, description }`, is empty unless the model judged the original itself wrong. Against the numbered source, like Source Anchors.
- **Normalizing a line:** drop its trailing comment, then all whitespace. The comment marker comes from a new optional profile field, `lineComment` (`//` for TypeScript, JavaScript, and Go; `#` for Python). The cut is naive: a marker inside a string literal truncates the line, which rarely matters at this length. User-defined profiles without `lineComment` compare whole lines.
- **Recorded** in `workout.json` as `originalDefect: { startLine, endLine, description, evidence }`, where `evidence` is `source`, `model`, or `both`. The lines come from the source match when there is one (otherwise from the model's report). The description comes from the model's report, or from `injectedBugDescription` when only the source matched. It is absent when neither signal fires. It is never retry feedback and never blocks saving: a Verified Workout is saved either way.
- **Shown only after the Attempt**, on Completed or Abandoned, before the rating question. It never appears in the README, Hints, Source Anchors, the runner's header, `kin quick`, or `list_workouts`: before solving, "this bug is in your code" narrows the search to the anchored lines.
  ```text
  ⚠ This bug may be real: src/context.py:9 has the same logic as this Workout's bug (Workout made from commit 1a2b3c4d5e6f).
    <the description>
  ```
  For a model report alone: *"The model that wrote this Workout thinks src/context.py:7-11 has a real bug: …"*. The runner's existing *"Source has changed since this Workout was made."* check applies. For a fetched Workout, the lines refer to the sharer's commit.
- **Confirmation.** After the notice: *"Is it a real bug in your code? [y] yes [n] no"* (any other key skips). The answer is recorded as `defectConfirmed` in `attempt.json` and in the outcome in `state.json`. It is asked only on the first finished Attempt of a Workout. It is the measure of how often each signal is right.
- **Prompt rule** (Drills and Katas): *"Keep the Reference Solution faithful to the original's behaviour. If the original itself looks wrong, don't fix it silently: say where and why in originalDefect."* A Drill may still use that defect as its bug, as the dogfooded one did. A Kata whose removed region fixes the original gets only the model report, since its Starting Code is a placeholder.
- **No comments in the bug** (Drills, enforced from now on; the prompt already forbade them). Comparing the two sides of the changed region by their trailing comments (via `lineComment`), a comment on a buggy line that the fixed side doesn't have is `[schema]` retry feedback: *"The bug region carries a comment that points at the bug; remove it."*
- **Agent mode:** `originalDefect` is part of the schema `submit_drill` accepts, and the agent gets the same prompt rule. `list_workouts` doesn't report it.
- **Not in v3.4:** choosing targets for suspected defects (see §11.11); a source match for Katas; reporting a defect anywhere else (an issue, the agent).

### 11.8 v4.0: Predictions (implemented)

*v4.0.0 was tagged on 2026-10-29, package still private. Verified for real on 2026-10-29 with headless Claude Code (agent mode): five Predictions, three on an SSTorytime Python file (`NChannel`, `NormalizeContext`, `STTypeDBChannel`) and two on Kintsugi's own TypeScript (`refill.ts`, `nextQuickWorkout`), all Verified on the first submission. Their true answers match the real code (checked by hand for the two Kintsugi ones), no Scenario or option used names from the code, and option lengths stayed within about 10 characters of each other. `NormalizeContext`'s true answer is its real bug (a trailing comma), reported as `originalDefect`. Not yet run for real: a Prediction in an interactive `kin train` (covered by tests), API mode, and the gate's rejections (covered by tests; no real submission was rejected).*

A **Prediction** trains *knowing what the system does* without reading code: the skill steering agents, triaging incidents, and checking behaviour against a spec all depend on. It is for engineering managers, architects, and developers who never open a source file, and for anyone else as a warm-up. Per [ADR 0007](./docs/adr/0007-answers-are-measured-never-asserted.md), every outcome it offers is measured by running code.

**What the human sees.**

```text
Scenario: A user has 3 Workouts waiting in the queue, and the cap is 3. They commit a
40-line change while background generation is on. What happens?

  [1] The oldest waiting Workout is discarded and a new one is generated.
  [2] The commit waits in the backlog until a slot opens; nothing is generated yet.
  [3] The commit is skipped for good.
  [4] A fourth Workout is generated and the cap is exceeded once.
```

One key answers; `[q]` leaves the Attempt open. No Hints, no editor, no file watching, and no test runs during the Attempt: everything was measured when the Workout was Verified. After answering, the runner shows:

1. right or wrong, and which option is true;
2. a plain-English explanation of why the system behaves that way;
3. for a wrong answer, the misunderstanding behind the chosen option (*"You were picturing a system where a full queue evicts its oldest Workout."*);
4. the Source Anchors, and, after a wrong answer, `[d]` for the code difference between the true behaviour and the chosen option, for those who want it.

A right answer **Completes** the Attempt; a wrong one reveals the truth and records it **Abandoned**. Either way the chosen option is saved in `attempt.json`, then the rating question follows as usual. Trying again is a new Attempt, with the options shuffled anew.

**Anatomy.**

- The **Scenario**: plain English with concrete values ("3 Workouts, the cap is 3"), asking what the system does.
- The **Reference Solution**: one unit extracted from the source and made self-contained, as for a Drill (stdlib only, inline fakes). Its behaviour is the true outcome.
- Three **Variants**, one per wrong option: the Reference Solution with one region of at most 3 lines changed, modelling a plausible misunderstanding (a boundary, an ordering, what is skipped, deferred, or kept, what is changed in place). Kintsugi builds each one from a snippet replacement `{ original, changed }`, where `original` occurs exactly once in the Reference Solution.
- Four **options**, each with its outcome text, the name of the one test that pins it down, and for a wrong option its Variant and the misunderstanding it stands for. The true option's Variant and misunderstanding are empty strings: providers' structured output support for optional fields varies.
- A test file with **one test per option**, each asserting that option's outcome.
- An explanation of the true behaviour, Source Anchors, and `originalDefect` (§11.7). No Hints.

**Verified** (§6, extended):

1. Against the Reference Solution, the true option's test passes and every other test fails by assertion.
2. Against each Variant, that option's test passes and every other test fails by assertion.
3. No test ever crashes (`error`), and the tests run against every version.
4. Each Variant differs from the Reference Solution by one region of at most 3 changed lines, and no two Variants are identical.
5. **No real wrong answer.** If a Variant's changed lines are found in the source file and the Reference Solution's aren't (the §11.7 source match, applied to each Variant), the "wrong" option is what the code actually does, and the extraction quietly changed it: retry feedback (*"Option 2's code is what the source does: the Reference Solution must behave like the source."*).

So the gate runs the tests four times: once against the Reference Solution, once against each Variant. It also checks that each option's `testName` matches exactly one test and that no test belongs to no option. "Exactly one option's test passes against each version" makes the four outcomes distinct, and ties each to exactly one version of the code.

**What the model writes.** `PredictionOutputSchema` shares the common fields (slug, title, pillar, minutes, Source Anchors, Reference Solution, tests, `originalDefect`), drops Starting Code, Hints, and the README (Kintsugi writes that itself), and adds `scenario`, `explanation`, and `options[]`: `{ text, testName, correct, variant: { original, changed }, misunderstanding }`. Checked afterwards as `[schema]` feedback:

- exactly 4 options, exactly one `correct`, the correct one without a Variant, every other with one;
- each `original` occurs exactly once in the Reference Solution and changes something, each wrong option has a misunderstanding, and no two options share a `testName`;
- **no code vocabulary:** a name from the code file (camelCase, PascalCase with an inner capital, or snake_case, at least 4 characters) appearing in the Scenario or an option's text is retry feedback. Product vocabulary ("the queue", `kin auto`) is fine. The explanation and the misunderstandings, shown after answering, are exempt.

**Prompt rules.** Choose the unit whose *behaviour* matters most to the people relying on it (business rules, policies, state transitions, what happens at limits), not the one with the most interesting logic; answer `worthPracticing: false` for algorithms or plumbing no user would notice. Write the Scenario with concrete values, and the four options as outcomes of similar length and style, so the true one doesn't stand out. Each Variant models one coherent wrong idea of the system, not a random change.

**Entry points.**

- `kin predict [<file>[#symbol] | <dir>] [--yes] [--no-sandbox] [--no-train]`. With a directory (the repository root when no path is given), Kintsugi picks the file itself: the most logic-dense file in that directory's shortlist (§11.3.1) that has never been Practised (§11.4). People who don't read code don't know file names; `kin predict src/sharing` reads as "ask me about sharing".
- Agent mode: `prepare_drill` takes `kind: 'prediction'` (no new tools); `/kin-drill <target> prediction` asks for one.
- On request only for now: `kin auto`, commit Workouts, and Tracks stay Drills until Predictions have been dogfooded. A config setting to have `kin auto` and `kin quick` favour Predictions (e.g. `"kinds": ["prediction"]`) is the expected next step.

**Everywhere else** Predictions are Workouts like any other. Every Prediction is Quick (at most 5 minutes; `--quick` doesn't apply), so `kin quick` and `kin quick --while` serve them. Ids start with `prediction_`. `README.md`, written by Kintsugi rather than the model, holds the Scenario and the options sorted alphabetically (so the order they were written in, true one first, gives nothing away), for browsing and sharing. The answer, explanation, misunderstandings, and Source Anchors live in `workout.json`, and the Reference Solution and tests in `.solution/`; there is no code file to work on, and Variants are rebuilt from their snippets whenever they are needed. An Attempt stores its shuffled `order` and its `answer` (indices into the options), and opens no sandbox. Finishing one counts as Practised in `kin map`, and `kin map --json` records which kinds each file was practised with, so a separate "system fluency" view can come later from real data. Cost, the spend ledger, `kin share`, and re-verification on fetch follow `workout.json`'s `kind`. Every Language Profile works unchanged.

**Not in v4.0:** Predictions from commits, `kin auto`, or Tracks; the `"kinds"` setting; architecture questions answered from the import graph (a likely later kind, also measured); incident-triage and diagram Workouts; Hints for Predictions.

### 11.9 v4.1: Predictions from commits (implemented)

*Verified for real on 2026-10-29 on five commits from Kintsugi's own history, with Kintsugi's commit prompt and schema answered by headless Claude Code through a test harness (API mode has no key here, and agent mode doesn't make these yet), then Kintsugi's own checks, gate, and saving. Four became Predictions (`parsers.ts`, `schema.ts`, `auto.ts`, `train.ts`); the text-only commit (`texts.ts`) was judged not worth practising, with a sound reason. Anchoring rejected two first attempts whose Previous Version rewrote the changed lines around the model's own fakes (one also invented a helper the old file never had); both passed on retry by copying the old lines as they are. One saved Scenario assumed a setting the product rejects (a personal preference for Katas, which `kinds` doesn't accept), a reminder that faithfulness is only as good as the extraction (ADR 0007). Not yet run for real: `kin refill` through the API, and the fallback with a real model (covered by tests).*

When an agent changes how the system behaves, the people relying on it keep the old picture until something surprises them. A **Prediction from a commit** asks what the code does *now*, in a situation the commit changed, and offers the old behaviour as one of the wrong answers. That wrong answer isn't invented: it is what the code did before the commit, measured by running it, and anchored to the file as it was. It follows [ADR 0007](./docs/adr/0007-answers-are-measured-never-asserted.md) and reuses commit selection (§11.2.4), the Prediction gate (§11.8), and the v3.4 source match (§11.7).

**The `kinds` setting.** Whether someone reads code is a fact about the person, not the repository, so the setting is personal: `"kinds": ["prediction"]` in the user-level config (`~/.config/kintsugi/`), which a repository's `.kintsugi/config.json` can override. The default is `["drill"]`, so nothing changes for existing users. It takes `drill` and `prediction`: Katas stay on request only (§11.5). The list is a preference with fallbacks, never a filter:

- **Commit generation** (`kin refill`, from the hook or by hand) makes the first kind listed, and falls back to the next one when a commit doesn't fit (below).
- **`kin quick`** serves queued Quick Workouts of the first kind listed first, then the rest in the existing order (from AI-written code first, then newest). With `["prediction"]`, Drills are still served when no Prediction is ready.

**What changes from a Prediction (§11.8).**

- The Scenario is one where the commit changed the outcome, asking what happens *now*.
- The four options are the true one (the Reference Solution, the unit as of the commit), **the old behaviour**, and two ordinary Variants.
- The old behaviour comes from **`previous`**: the same unit extracted from the file as it was before the commit, as a complete file. A commit can change up to 300 lines, so `previous` is exempt from the Variant's 3-line rule. In the output, its option is marked `previous: true` and has no snippet Variant; it is saved as `.solution/previous.<ext>`.
- The model receives the file before and after the commit, plus the diff (today it receives only the file as of the commit). The 3,000-line limit applies to each version. The background-generation consent says "the changed file, before and after the commit".
- The Scenario, the options, and the README never mention the commit or that anything changed: "after the latest change, …" would turn the question into "spot the new behaviour". The footer every README has ("Derived from commit …") stays.

**Verified, in addition to §11.8:**

1. **Measured:** against `previous`, only the old-behaviour option's test passes and every other test fails by assertion, exactly as for a Variant. So the gate runs the tests five times: the Reference Solution, `previous`, and two Variants.
2. **Anchored:** every region where `previous` differs from the Reference Solution must have a significant line (§11.7's normalisation and 8-character floor) found only in the file before the commit: in it, and not in the file after. Where `previous` has nothing (the commit added lines), a Reference Solution line found only in the file after it anchors the region instead. One line per region, not every line, because extraction renames things around a change (the dogfooded `NormalizeContext` Drill rewrote everything but its bug line); a line found in the old file alone is still evidence the region is the commit's change. Kintsugi reads the old file with `git show <sha>^:<path>`. This is the only mechanical evidence that the old-behaviour option really is the old behaviour rather than a fourth invented Variant, so a failure is retry feedback.
3. **Distinct:** `previous` differs from the Reference Solution and from every Variant.

**When a commit doesn't fit.** A commit that changed no behaviour (a refactor, a rename, a restructuring) has no Scenario with a different outcome: the model answers `worthPracticing: false`, and Kintsugi falls back to the next kind in `kinds` (with `["prediction", "drill"]`, a Drill from the same commit). A file the commit added has no "before" and falls back the same way. The fallback is a second model call, counted against the daily limit; if the limit runs out before it, the commit is *deferred* (not remembered), like any cap. With no fallback kind, the commit is skipped and remembered (`refill.processed`), so nobody pays for it twice.

**After answering**, on top of §11.8's reveal, a line written by Kintsugi rather than the model:

```text
What changed: commit 1a2b3c4d5e6f ("Defer commits when the queue is full"), co-written by an AI assistant.
Before it: The oldest waiting Workout was discarded and a new one generated.
```

Picking the old behaviour gets *"That was true until commit 1a2b3c4d5e6f."* in place of a misunderstanding. The model writes the old option's outcome text (checked for code names like every option) but not its misunderstanding: why it is wrong is known for a fact. After a wrong answer, `[d]` on the old option shows what the commit changed (`previous` against the Reference Solution).

**Entry points.** `kin refill` (hook or by hand) follows `kinds`; **`kin predict --commit <sha>`** asks for one explicitly: a Prediction and nothing else (no fallback), with `kin refill`'s foreground rules for consent and the caps (it may ask consent and ignores the caps). It takes no target, since the commit chooses its file. Agent mode doesn't make them yet. The commit's subject is saved with the Workout (`commit.subject` in `workout.json`) for the "What changed" line.

**Everything else is unchanged:** at most one queued Workout from commits per source file; the queue cap and the daily limit (retries and the fallback included); `--ai-only`, the backlog, and commit selection; expiry when the file changes substantially or after 14 days, which matters more here, since "what it does now" stops being true when the file changes again. A fetched commit Prediction re-verifies all four versions but skips the anchoring check: the sharer's before and after files aren't there (as for §11.8's real-Variant check). Commit Predictions aren't Track steps.

**Not in v4.1:** end-of-task Predictions in agent mode (usually about uncommitted changes: what "before" means with a dirty working tree needs its own design); a Prediction spanning several files of one commit.

### 11.10 v4.2: The Atlas

On a large codebase it is hard to choose what to practise: `kin drill <file>#symbol` assumes you already know the file and the symbol, which is what Kintsugi is meant to teach. The **Atlas** is a map of the repository that says what things are for, from the repository's overall organisation down to each file's key functions, so that "I want to understand retries" becomes `kin drill src/queue/retry.go#retryWithBackoff`. Per [ADR 0008](./docs/adr/0008-the-atlas-is-orientation-never-verified.md) it is orientation, not a Workout: labelled as written by a model, never Verified, never input to the gate.

**What it holds.**

- **The skeleton**, computed locally and free: the files `kin map` shows (tracked, recognised by a Language Profile) and their folders; line counts; each file's symbols with line ranges, found by the declaration regex (a Language Profile may override it with `declarationPattern`), named exactly as `#symbol` accepts them (a method as `Class.method`); a logic score per file and per function; the human's map state.
- **Atlas Entries**, written by a model: an **overview** of the repository (a few lines: how the codebase is organised); one line per folder; one or two lines per drillable file; one line for each **key function**, the top 5 of a file by logic score among symbols of at least 5 lines. Other symbols are listed by name only. Tests and generated files are listed but not described; files over 3,000 lines are described and marked *too long to drill*.
- **Keyed by content.** Each entry records the git blob hash of what it describes (a folder: its list of files). An entry whose hash no longer matches is *stale*: shown with `≈`, kept until refreshed. Nothing refreshes on its own, and background generation never touches the Atlas. "Once per release" is a habit, not a mechanism: running `kin atlas build` at release time costs only what changed since the last run.
- Stored in `.kintsugi/atlas.json`.

**Building it.**

- **Bottom up.** One call per leaf folder sees each file's outline plus the bodies of its key functions (not whole files) and writes the folder's, files', and key functions' entries. A parent folder is described from its children's entries, with no code resent. A last call writes the overview from the top-level entries.
- **API mode:** `kin atlas build [<dir>] [--yes]` describes that subtree (default: the whole repository), only what is missing or stale. It shows how many folders and files it will describe and the estimated cost, and asks to confirm (`--yes` skips it). It uses the repository's existing consent. Each call enters the spend ledger with `result: "atlas"`; `kin cost` shows an *Atlas* line. A partial Atlas is normal: describe the module you work in first.
- **Agent mode:** `prepare_atlas(dir)` returns the folder's skeleton, the code to read, the children's entries, and the writing rules; `submit_atlas(dir, entries)` checks and saves them. A submission is rejected, with feedback, when it leaves out a file of the folder, describes a symbol the skeleton doesn't have, or goes over the length limits (a folder or function: one line; a file: two lines; each at most 200 characters). The `/kin-atlas` skill runs the whole build in a subagent, bottom up, ending with the overview (`submit_atlas` with the root folder). These checks can't prove an entry true; they guarantee every name in the Atlas exists.

**Using it.**

- **`kin map`** shows the overview at the top and each folder's and file's one-line entry beside it, and a dim line when entries are stale (*Atlas: 14 files changed since described: `kin atlas build` to refresh*). `--json` includes the entries.
- **`kin atlas search "<goal>" [--all]`**, local and free: ranks files and symbols by keyword relevance (a match in a symbol or file name counts double over a match in an entry), then by map state (red and amber before green). It shows the top 10 (all with `--all`), each with its state and ready commands: `kin drill …#symbol`, `kin kata …#symbol`, `kin predict …#symbol`.
- **`kin atlas [<path>] [--markdown]`** prints the Atlas (or a subtree) as text, or as a Markdown document for anyone who wants to commit one.
- **Agent mode:** `/kin-drill <goal>` (words rather than a path) reads the Atlas through `search_atlas(goal)`, proposes 2 to 3 targets, and asks before generating.
- **Tracks:** when an Atlas exists, `kin explore`'s ordering call (and `prepare_track` in agent mode) sees the files' entries in place of raw outlines; `kin explore --about "<goal>"` picks the module through the same search (the folder of the best-matching files).

**Sharing.** `kin share --atlas` publishes `atlas.json` on the `kintsugi/workouts` branch (ADR 0006), unioned with a teammate's on a rejected push like Workouts. `kin fetch` merges it: for the same hash the local entry wins; a fetched entry fills a gap, and replaces a local entry that is stale when the fetched one matches the code. Entries carry no practice data.

**Not in v4.2:** model-understood search in API mode (the agent understands the wording in agent mode); a real parser; describing every function; refreshing on commit.

### 11.11 Later (not yet designed)

Each item needs its own design round before implementation.

- **End-of-task Predictions in agent mode:** what the agent just changed, before it's committed (§11.9).
- **Prediction accuracy stats:** how often the human predicts right, by file and over time.
- **Aiming at real bugs:** preferring units with suspected defects when choosing what to drill, if `defectConfirmed` (§11.7) shows the reports are mostly right.
- **Socratic coach:** LLM-powered hints on `[h]` that read the human's current code.
- **Spaced repetition:** resurfacing attempted Workouts on a schedule.
- **A public Workout library** for open-source codebases (a hosted service; a separate decision from team sharing).
- **`kin drill` with no path:** auto-pick the riskiest unpracticed file.
- **Opt-in editor integration:** disabling AI completions inside `.kintsugi/`.
- **LLM judge pass:** for Drill subtlety, if ratings show it's needed.
- **Local models** (e.g. Ollama).
- **Languages without a built-in test runner** (needs a new ADR).

## 12. Implementation Roadmap (v1)

1. **Foundation:** CLI scaffold, `kin init`, config loading (repo + user-level), credentials from env/user config.
2. **Sandbox:** the `Sandbox` interface over `@anthropic-ai/sandbox-runtime`, the policy in §7, env scrubbing, the canary, refusal + `--no-sandbox`.
3. **Language Profiles:** the four built-in profiles, the result parsers (TAP, `go test -json`, unittest verbose, JUnit XML), preflight, user-defined profile loading.
4. **Verified gate:** temp-dir test runner, the checks in §6, and the minimal-diff check.
5. **Drill synthesis:** prompt builder, schema, consent flow, the retry loop with failure feedback, persistence with Source Anchors.
6. **Runner:** file watcher, per-test display, Hints, give-up diff, Completed/Abandoned, ratings, `state.json`.

## 13. Implementation Roadmap (v2)

1. ~~**Workouts and Attempts**~~ Done (§11.2.2): immutable Workouts; Attempts in `.kintsugi/attempts/<id>/<n>/` with their own outcome, runs, Hints used, and rating; the runner works on an Attempt (resume or start); `kin discard` / `kin restore`; `kin cost` splits attempted from never attempted; `list_workouts` reports each Workout's status.
2. ~~**The queue and `kin quick`**~~ Done (§11.2.3): queue selection, `kin quick`, `kin drill --quick`. The failure summary line and the `kin refill` offer move to phase 3, which introduces the background log and `kin refill`.
3. ~~**Background generation from commits**~~ Done (§11.2.4): commit selection and the commit-diff prompt, `kin refill [--commit <sha>]` with the lock, backlog, caps, and log; `kin auto on|off|status` with the hook; expiry of Workouts from commits.

## 14. Implementation Roadmap (v3)

1. ~~**Tracks**~~ Done: the static shortlist, the ordering call, up-front generation with cost confirmation and step replacement, Track manifests, Origin `explore` (excluded from `kin quick`, the cap, and expiry), `kin explore`, `kin track`.
2. ~~**Tracks in agent mode**~~ Done: `prepare_track`, `{ trackId, why }` on `prepare_drill`, `finish_track`, and the skill's guidance.
3. ~~**Team sharing**~~ Done: the `kintsugi/workouts` branch via git plumbing, `kin share` (with the uncommitted-code refusal and unpushed-commit warning), `kin fetch` (union, id clashes, re-verification), "shared by" stamps, and the queue and expiry rules for fetched Workouts.

