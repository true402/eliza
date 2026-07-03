# Issue #11506 — on-device restart-loop root cause (Pixel 6a, ai.elizaos.app)

Clean repro + forensic root-cause for item 2 of #11506 (the live item after the
author retracted item 1): `ai.elizaos.app` restarting every ~1-2 minutes,
returning to the launcher, and onboarding "never persisting".

- Device: Pixel 6a (bluejay, serial 27051JEGR10034), Android 16, 5.7 GB RAM.
- Build under test: debug APK `versionName=1.0.0`, installed 2026-07-02 12:56:46
  (post-#11505 tree). All times below are device-local (PDT, UTC-7).
- Session: 2026-07-02, fresh launch at 13:42:52, full first-run onboarding
  driven on-device (local agent + on-device model), cold GPU chat turn sent.

## Verdict

**Root cause: OOM — lmkd kills the *foreground* app once its RSS reaches
~3.2-3.3 GB, and every kill is followed by a sticky-FGS restart that crashes
with `ForegroundServiceStartNotAllowedException`, extending the churn.**

The memory is dominated by the **in-process Vulkan inference host**: logcat
confirms `agent/arm64-v8a/libggml-vulkan.so … in-process bionic Vulkan host
over UDS "eliza_bionic_infer_v1"`, and `dumpsys meminfo` charges **GL mtrack
2.3-2.7 GB** (model weights + KV cache + compute buffers in Mali GPU memory)
plus a ~1 GB native heap (largely zram-swapped) to `ai.elizaos.app`. On a
5.7 GB phone with normal ambient apps resident, that breaches lmkd's low
watermark with swap low, and lmkd kills by RSS — the eliza app is always the
largest target, foreground or not.

Onboarding persistence is **not** a separate bug: the completion write is
atomic and awaited, and it survives process death once it happens (verified
live, below). Historically it "never persisted" because the process never
lived long enough to *finish* onboarding.

## 1. The ~1-2 min restart loop, fully attributed

`dumpsys activity exit-info ai.elizaos.app` (persisted by the OS across the
morning session; full dump in `exit-info-baseline.txt`) vs the bun agent's own
boot log on-device (`files/.eliza/bin-debug.log`, timestamps UTC → PDT):

| Death (exit-info) | pid | reason | RSS | importance | Next agent boot (bin-debug.log) | Gap |
|---|---|---|---|---|---|---|
| 12:35:12 | 28090 | **LOW_MEMORY (LMK)** | **3.3 GB** | 100 (foreground) | 12:35:31 | 19 s |
| 12:36:31 | 1803 | **LOW_MEMORY (LMK)** | **3.3 GB** | 125 | 12:36:46 | 15 s |
| 12:37:39 | 4210 | **LOW_MEMORY (LMK)** | **3.3 GB** | 125 | 12:38:24 | 45 s |
| 12:39:17 | 5466 | **LOW_MEMORY (LMK)** | **3.2 GB** | 125 | 12:39:25 | 8 s |
| 12:40:27 | 6297 | **LOW_MEMORY (LMK)** | **3.2 GB** | 125 | — (crash loop below) | — |
| 12:40:31 | 7650 | APP CRASH (FGS restart) | — | 300 | — | — |
| 12:40:33 | 7868 | APP CRASH (FGS restart) | — | 300 | — | — |
| 12:44:45 | 7868 | APP CRASH (FGS restart) | — | 300 | 12:45:19 | 34 s |
| 12:45:06, 12:49:27, 12:54:09, 12:56:46-47 | … | USER REQUESTED / PACKAGE UPDATED | — | — | 12:49:34, 12:54:13, 12:56:55 | (developer force-stops + reinstall) |

Successive LMK deaths: **79 s, 68 s, 98 s, 70 s apart — exactly the reported
"every ~1-2 minutes"**. Every single death in the window is either an LMK
LOW_MEMORY kill at 3.2-3.3 GB RSS, the follow-on FGS crash, or the developer's
own force-stop. There are **no** WebView renderer-gone cascades and no ANRs
for this package.

### The secondary crash: sticky FGS restart is illegal from background

`dumpsys dropbox --print data_app_crash` (`dropbox-crashes.txt`), both records
12:40:31 / 12:40:33 — matching exit-info #9/#10:

```
Process: ai.elizaos.app
java.lang.RuntimeException: Unable to create service ai.elizaos.app.ElizaAgentService
Caused by: android.app.ForegroundServiceStartNotAllowedException:
  Service.startForeground() not allowed due to mAllowStartForeground false:
  service ai.elizaos.app/.ElizaAgentService
```

Mechanism: `ElizaAgentService.onStartCommand` returns `START_STICKY` and
`onCreate()` calls `startForeground()` unconditionally
(`packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaAgentService.java:600-648`).
After an LMK kill the app has no foreground activity, so when AMS restarts the
sticky service, Android 12+ denies the FGS start and `onCreate` throws →
process crashes → AMS retries → repeat (3 crash records). The "returns to
launcher" UX is the LMK kill of the foreground activity; the crash loop keeps
the process churning afterwards.

## 2. Live repro session (fresh launch 13:42:52, pid 21492)

Monitors: 5 s pid sampler (`pid-timeline.log`), 20 s
meminfo/oom_score_adj/MemAvailable sampler (`meminfo-timeline.log`), filtered +
unfiltered + events-buffer logcat (`logcat-filtered.log`, `logcat-events.log`;
NearbyDiscovery greppable-around in the unfiltered capture, kept out of the
committed evidence for size).

Memory ramp after one onboarding flow + one chat turn (from
`meminfo-timeline.log`):

| Time | PSS | GL mtrack (Graphics) | Device MemAvailable |
|---|---|---|---|
| 13:42:49 (launch+0 s) | 0.42 GB | 0.17 GB | 2.11 GB |
| 13:43:10 | 1.33 GB | 0.13 GB | 1.68 GB |
| 13:43:31 (model loading) | 2.32 GB | 1.81 GB | 0.85 GB |
| 13:44:34 (onboarding done) | 2.80 GB | 2.49 GB | 0.33 GB |
| 13:45:36 (turn in flight) | **2.95 GB** | **2.68 GB** | 0.30 GB |
| 13:46-13:53 (steady) | ~2.6-2.75 GB | ~2.33-2.50 GB | 0.3-0.5 GB |

30 s after launch the events buffer logged `am_low_memory: 50`, and lmkd began
killing everything else on the device ("low watermark is breached and swap is
low"): 16 victims in ~2 minutes (Chrome ×4, gms, Maps, Messages, Twitter,
permissioncontroller, ShannonImsService, …) while `ai.elizaos.app` sat at
oom_score_adj 0 holding ~2.8 GB. That is the device state the morning session
started from — with those apps still resident, the watermark breach kills the
eliza app itself (RSS 3.2-3.3 GB after chat context/KV growth), foreground or
not.

The live process survived >12 minutes *only because* the device was otherwise
idle and lmkd had already evicted every other candidate — confirming the kill
is pure memory-capacity, not a timer, watchdog, or WebView cascade. A cold GPU
chat turn took multiple minutes under the accompanying zram thrash (~200 MB
SwapPss), matching the issue's "a cold GPU turn needs ~40-60 s, so it rarely
survives long enough to complete" when deaths were landing every ~70-100 s.

## 3. Onboarding persistence — NOT a bug, a casualty of the kill loop

Write path (verified in source): completing onboarding `await`s
`POST /api/first-run`, whose handler sets `meta.firstRunComplete = true` and
saves the agent config atomically (`writeFileSync` tmp + `renameSync`) *before*
returning 200; only then does the UI set `localStorage["eliza:first-run-complete"]`
(mirrored to `CapacitorStorage.xml`). Boot reads the agent config via
`GET /api/first-run/status`.

Verified live on-device immediately after completing onboarding at 13:44:

```
$ run-as ai.elizaos.app cat files/.eliza/eliza.json | jq .meta
{"firstRunComplete": true}
$ run-as ai.elizaos.app cat shared_prefs/CapacitorStorage.xml | grep first-run
eliza:first-run-complete = 1
```

…and after a subsequent process restart the app boots **past onboarding**
(screenshot `screen-9-after-restart.png`). The historical "onboarding never
persists" is simply: the process died every ~70-100 s, always *before* the
user could reach the final onboarding step, so the awaited write never
executed. Chat history (stored earlier in the agent DB) survived all along —
visible in `screen-4` where a previous session's exchange is present.

## 4. Adversarial re-validation (second agent, same day, 15:08-17:03 PDT)

Every death claim above was re-checked against the raw persisted OS records by
a second agent before this evidence was pushed:

- The five `reason=3 (LOW_MEMORY)` records at rss 3.2-3.3 GB (12:35:12,
  12:36:31, 12:37:39, 12:39:17, 12:40:27 — gaps 79/68/98/70 s) and the three
  `reason=4 (APP CRASH(EXCEPTION))` records (12:40:31, 12:40:33, 12:44:45)
  are all present verbatim in `exit-info-baseline.txt`. No other organic death
  reasons exist in the window; everything else is `USER REQUESTED (FORCE STOP)`
  or `PACKAGE UPDATED` from the operator's own reinstall cycle.
- **The live-session process survived far longer than 12 minutes.** Exit-info
  (`exit-info-live-check.txt`) shows the 13:42:52 launch (pid 21492) stayed
  alive until a deliberate operator force-stop at **15:09:20 — 87 minutes —
  holding rss 5.0 GB with the model loaded**, on an otherwise-idle device.
- The 15:41:15 (pid 18782, rss 4.4 GB, `clear data`) and 15:43:23 (pid 26306,
  `FORCE STOP`) deaths in the afternoon window are both operator actions
  (fresh-install persistence testing), not organic kills.
- The final process (pid 27906, launched 15:43:28) was sampled every 5 s until
  17:03:24 — **80 minutes, zero pid churn** (`pid-timeline.log`), idling at
  ~142 MB PSS with the model unloaded.

Net: zero organic deaths outside the morning memory-pressure window, in either
foreground or background, across ~4 hours of combined monitoring. The kill
loop is fully explained by LMK memory capacity + the FGS-restart crash
cascade; there is no timer, watchdog, ANR, or WebView-renderer cascade.

## Files

- `exit-info-baseline.txt` — full `dumpsys activity exit-info` (the morning kill loop).
- `exit-info-final.txt` — same after the live session (15:08 capture).
- `exit-info-live-check.txt` — same after the afternoon persistence tests (15:45 capture).
- `dropbox-crashes.txt` — both FGS-restart crash stacks.
- `pid-timeline.log` — 5 s pid samples (15:32-17:03 window).
- `meminfo-timeline.log` — 20 s PSS/GL/adj/MemAvailable samples.
- `logcat-filtered.log` — eliza/AM/LMK/crash-filtered logcat.
- `logcat-events-memkills.log` — events buffer extract (`am_low_memory`,
  `am_kill`, `am_proc_start`/`am_proc_died` for `ai.elizaos.app`).
- `screen-*.png` — onboarding flow, chat turn (screen-4 also shows prior
  session's chat history surviving restart), post-restart boot past onboarding
  (screen-9), healthy agent after restart (screen-10).
- `repro-notes.txt` — timestamped operator actions.

The morning boot-time correlations in §1 were read live from the on-device
`files/.eliza/bin-debug.log`; that raw file was later destroyed by the
15:41 `pm clear` persistence test, so the derived table above is its record
(gaps corroborated by `am_proc_start` events in the events buffer).

## Fix directions

1. **Small + obvious (PR `fix/11506-fgs-restart-crash`, Refs #11506):** make
   the sticky-restart path survive the Android 12+ background-FGS denial
   instead of crash-looping: catch the `ForegroundServiceStartNotAllowedException`
   thrown through `startForeground()` in `onCreate`, record a diagnostic
   event, stop self cleanly, and let the next real (foreground) launch start
   the service. On-device restart diagnostics for the artifact landed
   separately via #11560.
2. **The capacity problem (needs a product decision, out of scope):** the
   in-process Vulkan host pins ~2.3-2.7 GB of GPU memory for the model on a
   5.7 GB phone. Options include a smaller default model / quant for ≤6 GB
   devices, unloading model weights when the app is backgrounded, KV-cache
   caps, or moving inference to an isolated process so LMK can reclaim it
   without killing the UI. Tracked in the issue.
