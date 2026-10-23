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

No Workout is written to `.kintsugi/workouts/` unless every check passes. Each test run executes in a fresh temp directory, inside the sandbox (§7), with a 10 s timeout.

1. **Reference passes:** running the tests against the Reference Solution: `ran` is true and every test is `pass`.
2. **Starting Code fails meaningfully:** running the tests against the Starting Code: `ran` is true, at least one test is `assertion-failure`, and at least one test is `pass`. No test may be `error`.
3. **Drill only:** the Regression Test is among the `assertion-failure`s.
4. **Minimal diff:**
   - *Drill:* Starting Code differs from the Reference Solution in one contiguous region of ≤ 3 changed lines.
   - *Kata:* Starting Code is the Reference Solution with exactly one region replaced by a gap; for a Quick Workout the removed region is 5–12 lines. (Katas aren't generated in v1, but the rule is part of what Verified means.)

**On failure:** retry generation up to 2 more times, feeding the exact failing check and test output back to the LLM. If the third attempt fails, report `Couldn't produce a Verified Workout from <target>` and write nothing.

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
3. **Consent:** on the first generation in a repo, show the files that will be sent and the provider, ask `Send code to <provider>? [y/N]`, and remember the answer in `.kintsugi/config.json`. `--yes` bypasses.
4. **Synthesize:** send the target (and `#symbol` if given) to the LLM with the Drill prompt (§9).
5. **Verify:** run the Verified gate (§6), with retries.
6. **Persist:** write the Workout (§10), stamping Source Anchors with the current commit SHA.
7. **Train:** open the runner (§10) unless `--no-train`.

Progress is shown as steps in the foreground throughout (expect ~30–120 s).

## 9. LLM Output Schema & Drill Prompt Rules

```typescript
import { z } from 'zod';

export const WorkoutSchema = z.object({
  worthPracticing: z.boolean().describe('False if the target is trivial CRUD, config, or glue code.'),
  kind: z.enum(['kata', 'drill']),
  slug: z.string().describe('URL-safe short slug, e.g. edf-tie-breaker'),
  title: z.string(),
  pillar: z.enum(['algorithm', 'pattern', 'library']),
  estimatedMinutes: z.number().min(2).max(15),
  sourceAnchors: z.array(z.object({
    filePath: z.string(),
    lineRange: z.string(),
    explanation: z.string(),
  })),
  readmeMarkdown: z.string(),
  hints: z.array(z.string()).length(2).describe('Ordered: gentle nudge first, sharper second. Neither states the fix.'),
  startingCode: z.string(),
  referenceSolution: z.string(),
  testSuiteCode: z.string().describe('3 to 5 tests.'),
  regressionTestName: z.string().optional().describe('Drill only: the test that exposes the injected bug.'),
  injectedBugDescription: z.string().optional().describe('Drill only: internal note on the exact bug.'),
});
```

If `worthPracticing` is false, Kintsugi reports that and stops (no retry).

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
    │       ├── workout.json       # hints, regression test, bug note, anchors, metadata
    │       └── .solution/kata.ts  # Reference Solution: out of the way, not secret
    └── done/                      # Completed and Abandoned Workouts move here
```

API keys come only from environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or the user-level config at `~/.config/kintsugi/`. Never from `.kintsugi/`.

### Runner (`kin train`)

- Prints clickable paths to `README.md` and the code file, and opens them in `$VISUAL` if set.
- Watches the Workout directory itself (language-agnostic) and re-runs `testCmd` (sandboxed) on every save, showing per-test results.
- If the source file has changed since the anchored commit, shows: *"Source has changed since this Workout was made."*
- Keys:
  - `[h]` reveals the next Hint (counted).
  - `[g]` gives up: shows the diff against the Reference Solution and marks the Workout **Abandoned**.
  - `[q]` quits, leaving the Workout pending.
- When every test passes, the Workout is **Completed**.
- On Completed or Abandoned, asks *"Was this a good Workout? [👍/👎]"* and moves the Workout to `done/`.

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

`attempts` counts test runs triggered by saves. Ratings are local only and exist to tune prompts.

## 11. Beyond v1 (not yet designed)

Each item below needs its own design round before implementation.

- **Kata generation:** the gap-filling Workout kind (the Verified rule already exists).
- **Commit watcher:** a non-blocking `post-commit` hook that pre-generates Workouts from new commits (especially AI-authored ones) into a ready queue.
- **`kin quick [--while "<cmd>"]`:** instantly launch a Quick Workout from the queue, optionally while a slow build/CI command runs in the background; fall back to the uncommitted diff if the queue is empty.
- **`kin explore <path>`:** rank a module's files by complexity and centrality, and generate a Track (algorithm → pattern → library).
- **`kin map`:** a repo heatmap of practiced, recently changed and unpracticed, and unexplored complex areas.
- **Socratic coach:** LLM-powered hints on `[h]` that read the human's current code.
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
