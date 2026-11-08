# No telemetry, not even opt-in

Fiu sends nothing about its use anywhere: no usage metrics, no error reports, no Workout ratings, no costs. The only data that leaves the machine is the source code sent to the user's own LLM provider, with consent. Ratings, outcomes, and the spend ledger live only in `.fiu/state.json`.

Telemetry would tell us how often Drills are Verified, what they cost, and which ones people rate well, which is exactly what we need to improve prompts. We chose to get that signal from dogfooding and from issues people open instead. Fiu runs inside private repositories, and a tool that reports code-adjacent data home (even opt-in, even anonymised) loses the trust an open-source developer tool depends on, and that trust is far harder to win back than a signal is to collect another way.
