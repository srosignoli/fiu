# Kintsugi: Specification (v1)

> Domain terms (Workout, Kata, Drill, Track, Quick, Starting Code, Reference Solution, Hint, Source Anchor, Regression Test, Verified, Language Profile, Completed, Abandoned) are defined in [GLOSSARY.md](./GLOSSARY.md). Decisions with lasting trade-offs live in [docs/adr/](./docs/adr/).

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
| `kin explore <path> [--yes] [--no-sandbox] [--no-train]` | Build a Track for a module directory (§11.3.1). |
| `kin track [<track-id>] [--no-sandbox]` | List Tracks, or show one's progress and open its next step (§11.3.1). |
| `kin share <id>... [--remote <name>]` / `kin fetch [--remote <name>] [--no-sandbox]` | Share Workouts or Tracks with the team on the `kintsugi/workouts` branch, or bring in theirs, re-verified (§11.3.2). |
| `kin quick [--no-sandbox]` | Start the queue's best Quick Workout right away (§11.2.3). |
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

### 11.4 Later (not yet designed)

Each item needs its own design round before implementation.

- **`kin quick --while "<cmd>"`:** serve a Quick Workout while a slow build or CI command runs in the background, with a status line (v2.1).
- **Kata generation:** the gap-filling Workout kind (the Verified rule already exists; gaps must fail by assertion, not raise).
- **Socratic coach:** LLM-powered hints on `[h]` that read the human's current code.
- **Spaced repetition:** resurfacing attempted Workouts on a schedule.
- **A public Workout library** for open-source codebases (a hosted service; a separate decision from team sharing).
- **`kin map`:** a repository heatmap of practiced, recently changed and unpracticed, and unexplored complex areas (after v3, once there is practice history).
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

