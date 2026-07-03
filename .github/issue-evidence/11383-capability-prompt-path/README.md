# #11383 Capability Prompt Path Evidence (PR #11580)

Issue: LifeOps `*-capability` scenarios did not exercise their optimized-prompt
path under a live model — the planner routed capability requests to promoted
list/aggregate subactions, and even when the capability consumer fired, the
purpose-tagged model call never landed in the recorded trajectory.

## What the PR ships

1. **Inbox triage capability route** — the `INBOX` `triage` subaction now
   fetches fresh cross-channel messages, calls `InboxService.triage` (the
   `inbox_triage` optimized-prompt consumer via `classifyMessages`), persists
   one triage row per newly classified message, and only then returns the
   pending queue. Action descriptions / routing hints / promoted-subaction
   overrides disambiguate triage from the list/summarize reads. A
   `classification`-filtered call is a persisted-queue read and skips the
   fetch + LLM classification pass (review feedback).
2. **`runWithTrajectoryPurpose` (core) + full wiring** — passing a bare
   `{ purpose }` to `runWithTrajectoryContext` REPLACES the active context:
   `trajectoryStepId` is dropped, so `runtime.recordLlmCall` returns before
   logging and the purpose tag is lost. The new helper preserves the ambient
   context and overrides only `purpose`. All 27 bare-purpose callsites are
   wired: plugin-inbox (triage-classifier, priority-scoring, reflection),
   plugin-personal-assistant (16 files incl. the `schedule_plan` and
   `reminder_dispatch` consumers), plugin-goals, plugin-health
   (`screentime_recap`), packages/shared email classifier, core
   extractor-pipeline. `calendar_extract` flows through the PA
   `runLifeOpsJsonModel` helper, which is on the fixed path.
3. **TrajectoriesService step-wipe fix (core)** — `sanitizeTrajectoryJsonValue`
   coerced empty plain objects (`observation: {}`, pending
   `action.parameters: {}`) to the string `"[object Object]"`; the read-side
   normalizer then rejected the whole steps array and the next
   load-mutate-persist cycle (`endTrajectory`) wrote `steps_json` back as
   `[]`, silently destroying every recorded step + LLM call. The JSON-file
   recorder already carried this exact fix; the service's sanitizer copy did
   not. Empty plain objects now round-trip as `{}`.
4. **Scenario-runner trajectory seam** — the runner dispatches straight into
   `messageService.handleMessage`, so no turn ever had a scenario-tagged
   trajectory + step. `executeMessageTurn` now mints
   `startTrajectory({ scenarioId }) + startStep`, threads
   `metadata.trajectoryStepId` into the message (mirroring the production
   `MESSAGE_RECEIVED` seam), and ends the trajectory with
   completed/error/timeout. This is what makes `modelCallOccurred` final
   checks observable — for every capability scenario, not just inbox.

## Live before/after (CLI live lane, no API key — `ELIZA_CHAT_VIA_CLI=claude`)

Both runs: `bun packages/scenario-runner/bin/eliza-scenarios run
plugins/plugin-personal-assistant/test/scenarios --scenario
inbox-triage-capability --lane live-only` on the PR head, live `claude`
backend (cold `claude --print` per call, subscription credentials on disk —
the #10757 lane).

- **Before (route fix only, recording seam broken)** —
  `live-cli-before/report.json`: the capability itself worked (turn 4 routed
  to `INBOX_TRIAGE`, the live classifier produced urgent/ignore/needs_reply,
  3 rows persisted, readback finalCheck passed) but
  `modelCallOccurred: expected 1 matching model call(s) with purpose
  [inbox_triage], saw 0. Observed purposes: (no model-call purposes)` —
  the trajectory layer recorded nothing, for any purpose, on any turn.
- **After (seam + step-wipe fixes)** — `live-cli-after/report.json`: scenario
  **passed** in 83.6 s. All four turns routed to their INBOX subactions
  (`INBOX_LIST`, `INBOX_SUMMARIZE`, `INBOX_SEARCH`, `INBOX_TRIAGE`);
  `modelCallOccurred: matched 2 model call(s) with purpose [inbox_triage]`;
  organic-persistence readback passed. Live classification on turn 4
  ("Triage my inbox and tell me what needs my attention right now"):
  - production-outage DM → `urgent` / high — "Production outage with revenue
    loss requiring immediate approval from the owner."
  - promo newsletter → `ignore` / low — "Automated promotional marketing
    email with no action required."
  - scheduling question → `needs_reply` / low — "Dana is asking to confirm or
    reschedule a meeting time, which expects a response."

## Local validation (all green, this branch)

- `bun run --cwd plugins/plugin-inbox test` — 140 passed (incl. fresh-message
  classification, already-triaged filtering, fail-closed classifier error,
  classification-filter read gate)
- `bun run --cwd plugins/plugin-personal-assistant test` — 997 passed
- `bun run --cwd plugins/plugin-health test` — 152 passed
- `bun run --cwd plugins/plugin-goals test` — 53 passed
- `bun run --cwd packages/shared test -- src/email-classification/email-classifier.test.ts` — 13 passed
- `bun run --cwd packages/core test -- src/__tests__/trajectory-context.test.ts src/features/trajectories` — 51 passed
  (incl. the step-wipe lifecycle regression + `runWithTrajectoryPurpose` unit tests)
- `bun run --cwd packages/scenario-runner test` — 224+ passed (incl. the
  per-turn trajectory-seam executor tests)
- Package-scoped `typecheck` green for core, shared, scenario-runner,
  plugin-inbox, plugin-goals, plugin-health
- `git diff --check` clean

## Files

- `live-cli-before/` — report.json + console excerpt (recording gap visible)
- `live-cli-after/` — report.json + console excerpt + run-dir listing (pass)
