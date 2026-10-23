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
| `kin drill <file>[#symbol] [--no-train] [--yes] [--no-sandbox]` | Generates a Drill from `<file>` (the LLM picks the most bug-worthy unit unless `#symbol` pins one), verifies it, and opens it in the runner. `--no-train` only saves it; `--yes` skips the consent prompt; `--no-sandbox` runs Workout code unsandboxed for this invocation only (§7). |
| `kin train [workout-id] [--no-sandbox]` | Opens the runner on a pending Workout (picker if no id given). |

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
}
```

Every test run is normalised to:

```typescript
type TestOutcome = 'pass' | 'assertion-failure' | 'error';
interface TestRun {
  ran: boolean;                          // false on compile/syntax/import failure, missing result file, or timeout
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
| Resources | 10 s wall-clock timeout that kills the command's whole process group; output capped at 1 MiB per stream. |

**Known gap: no memory or process-count limits.** `ulimit -v` breaks Node (V8 reserves large virtual address ranges), `ulimit -u` counts all of the user's processes rather than the command's, and cgroups (`systemd-run --user`) are unavailable on macOS and many WSL setups. A fork bomb or memory spike is bounded only by the timeout. Revisit before public release.

All execution goes through one internal `Sandbox` interface; `@anthropic-ai/sandbox-runtime` is the v1 implementation and can be swapped.

**Canary:** `kin init` (always fresh) and the preflight (cached for a week per platform, Node version, and sandbox-runtime version) run a canary inside the sandbox that tries to open a network connection, write outside the Workout directory, read a planted secret and every existing secret path above, and read a scrubbed env var. All must be refused, and a write inside the Workout directory must succeed (so a canary that can't run at all never counts as a pass); otherwise the sandbox is treated as unavailable.

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
    └── done/                      # Completed and Abandoned Workouts move here
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
- On Completed or Abandoned, asks *"Was this a good Workout? [y] 👍 [n] 👎"* (any other key skips) and moves the Workout to `done/`.

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

`attempts` counts test runs triggered by saves (not the initial run). `hintsUsed` counts Hints revealed. Ratings are local only and exist to tune prompts. Leaving with `[q]` records nothing.

## 11. Release Plan

### 11.1 Before v1.0 (release blockers)

1. **Dogfooding milestone.** About 10 real Drills across ≥ 3 languages in ≥ 2 real repositories, logging generation attempts, cost, and ratings, then a review. v2's plan may change on what it shows (Verified rate, cost per Drill, subtlety).
2. **Cost recording** (§11.2.1).
3. **npm scope** chosen; `"private": true` removed.
4. **Sandbox resource limits** (§7 known gap): solved, or documented prominently.
5. **Sandbox verified** on macOS and native Linux (so far only WSL).

### 11.2 v2: Habit and automation

Turn Drills into a habit: Workouts are pre-generated from your commits in the background, and `kin quick` serves one instantly during the waits of agent-driven work. Out of scope for v2: `--while`, Katas.

#### 11.2.1 Cost visibility (ships in v1.0)

- Every LLM call's usage is recorded: input, output, and cached tokens, and the model that actually answered (a refusal fallback may switch models).
- Dollars are **estimates** from a price table built into each Kintsugi release, overridable per model in config. A model with no known price shows tokens only, marked "cost unknown".
- A Workout's cost is the sum of **all** its generation attempts, including rejected ones. It is stored in `workout.json` and shown in its README ("Generated for ≈ $0.38 over 2 attempts"), the runner's header, and the `kin train` picker.
- A **spend ledger** in `state.json` records every generation, including those that produced no Workout (not Verified, not worth practicing).
- **`kin cost [--since <date>]`** (default: this month) splits spend into: Workouts attempted; Workouts never attempted, including Discarded ("money left on the table"); generations that produced nothing; and background versus manual.
- No estimate is shown before generating. Once the ledger has history, `kin drill` and `kin auto on` show "your Drills have averaged $X (last N)".

#### 11.2.2 Workouts and Attempts

Per [ADR 0003](./docs/adr/0003-workouts-are-immutable-attempts-hold-outcomes.md):

- A **Workout** (`.kintsugi/workouts/<id>/`) is an immutable, Verified definition; it never moves or changes. `done/` goes away.
- An **Attempt** is one try at a Workout, in a fresh copy at `.kintsugi/attempts/<workout-id>/<n>/`. Outcomes (Completed, Abandoned), Hints used, and **runs** (test runs triggered by saves; v1's `attempts` counter) belong to the Attempt. Finished Attempts are kept, with the human's final code.
- At most one open Attempt per Workout: `kin train <id>` resumes it, or starts a new one. Redoing a Workout is always explicit.
- **Discarded** is a Workout-level state meaning archived: hidden from the queue and not counted against its cap, but kept and restorable (`kin discard <id>`, `kin restore <id>`). Workouts from commits expire into it after 14 days (configurable).
- v1 data is migrated on first run (each `done/` Workout becomes a Workout with one finished Attempt).

#### 11.2.3 The queue and `kin quick`

- The **queue** is the Workouts that have never been attempted and aren't Discarded: one pool for manual and background Workouts. Each Workout records its **Origin**: `manual` or `commit:<sha>`.
- **`kin quick`** picks the best queued **Quick** Workout (from AI-authored commits first, then newest; skipping any whose source file no longer exists) and opens the runner at once: no picker, no prompts, and it exits when done. With nothing ready, it offers to run `kin refill` in the foreground. There is no uncommitted-diff fallback.
- **Quick** is enforced mechanically: `estimatedMinutes ≤ 5` and Starting Code ≤ 60 lines, as `[schema]` retry feedback. Workouts from commits are always Quick; manual ones with `kin drill --quick`.

#### 11.2.4 Background generation from commits

- **Opt-in only.** `kin auto on` asks a separate consent covering background spending and its caps, records it in `.kintsugi/config.json`, and installs the hook. `kin auto off` removes exactly what Kintsugi added. `kin auto status` shows on/off, today's budget used, the queue size, and the latest failures. `kin init` never enables it, only mentions it.
- **The hook.** `.git/hooks/post-commit` (untracked): written if absent, otherwise a clearly marked block is appended and the user's lines are never rewritten. With `core.hooksPath` set (husky, lefthook), Kintsugi prints the snippet to add instead of editing tracked files. The hook only starts `kin refill --commit <sha>` detached; the commit never waits. `kin refill` can also be run by hand.
- **Which commits.** Every commit by you is a candidate; commits with known AI `Co-Authored-By` trailers (Claude, Copilot, Cursor, …) get priority, and config can restrict generation to them. Skipped before any LLM call: merges; commits made mid-rebase or mid-cherry-pick; other authors' commits; commits touching only docs, config, lockfiles, tests, generated or vendored code; tiny diffs.
- **What a commit becomes.** At most one Drill: among changed files a Language Profile recognises (minus tests, generated, and vendored paths), the one with the most changed lines. The model gets that file as of the commit plus its diff, and builds the Drill around the change.
- **No paying twice.** At most one queued Workout from commits per source file; the backlog collapses entries for the same file.
- **Caps.** Nothing is generated while the queue holds 3 Workouts, and at most 5 generations (retries included) run per day. Both are configurable.
- **Running unattended.** Never prompts. A per-repo lock allows one generator at a time; commits arriving meanwhile join a backlog that keeps the newest 5. With no consent, no `kin auto on`, or no API key, it skips and logs. Results go to `.kintsugi/log` (`kin log`); the next `kin quick`/`kin train` shows a one-line summary of failures. Docs recommend keeping the API key in the user config, since commits made from GUI tools may not see shell environment variables.

### 11.3 v3: Onboarding and team sharing

- **`kin explore <path>`:** rank a module's files by complexity and centrality, and generate a Track (algorithm → pattern → library).
- **Team sharing:** Workouts (definitions only, never Attempts) shared with exactly the people who can read the repository, so nobody pays to regenerate what a teammate already generated. The mechanism needs its own design round.
- **`kin map`:** a repository heatmap of practiced, recently changed and unpracticed, and unexplored complex areas.

### 11.4 Later (not yet designed)

Each item needs its own design round before implementation.

- **`kin quick --while "<cmd>"`:** serve a Quick Workout while a slow build or CI command runs in the background, with a status line (v2.1).
- **Kata generation:** the gap-filling Workout kind (the Verified rule already exists; gaps must fail by assertion, not raise).
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
