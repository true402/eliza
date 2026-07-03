# Issue #11741 — Audio/SFX Provider Registry Evidence

## What Changed

- Added `packages/cloud/shared/src/lib/providers/audio/` (types, normalizer, registry, three providers) mirroring the image provider registry and the video registry shape from #11749: providers are keyed by pricing-catalog `billingSource` and additionally declare `capabilities` (`music` | `sfx`), `displayName`, and `requiresStorage`.
- Moved the FAL (queue client), ElevenLabs (bytes → R2), and Suno-compatible music implementations out of `/api/v1/generate-music` into provider modules; the route now resolves via `getAudioProvider(billingSource, productFamily)` and fails closed for unknown billing sources and capability mismatches.
- Generalized the music pricing surface to audio: `PricingProductFamily` gains `sfx` (plain-text DB column, no migration), `SUPPORTED_AUDIO_MODELS` / `AUDIO_SNAPSHOT_PRICING` / `getSupportedAudioModelDefinition` / `buildAudioSnapshotEntries` / `calculateAudioGenerationCostFromCatalog` replace the music-named forms (single in-repo consumers updated; no aliases kept).
- Wired three SFX models with conservative upper-bound pricing rows (`manual_override_recommended`, matching the existing music snapshot convention): `elevenlabs/sound_effects` (direct `/v1/sound-generation`, bytes persisted to R2), `fal-ai/elevenlabs/sound-effects`, and `fal-ai/stable-audio-25/text-to-audio` (each with model-specific FAL input mappings that fail closed for unmapped SFX models).
- MMAudio remains an explicit documented deferral in `media-model-roster.ts` (video-to-audio needs a source-video input contract the route does not accept); Stable Audio and ElevenLabs sound effects flipped to `wired` roster entries.
- Behavior improvements over the old route: missing provider credentials and missing R2 storage now 503 BEFORE credit reservation (previously threw after reserving, forcing a refund cycle); ElevenLabs storage keys are `generations/sfx/...` for SFX and stay `generations/music/...` for music.

## Manual Review

- Reviewed `packages/cloud/api/v1/generate-music/route.ts`: no provider-specific request construction remains inline; reserve → generate → settle → persist order and the #10278 `chargeSettled` guard are unchanged; response shape (`music`, `status`, `cost`) preserved.
- Reviewed `packages/cloud/shared/src/lib/providers/audio/*`: the moved FAL/ElevenLabs/Suno logic is byte-for-byte equivalent to the old route branches (music input aliases incl. the `lyrics_optimizer` default, ElevenLabs `music_length_ms`/`model_id` mapping, Suno base-URL trailing-slash strip).
- Reviewed the only lockfile delta: `@fal-ai/client` added to the `packages/cloud/shared` dependency block (same version as `cloud/api`; #11749 adds the identical line for video).

## Validation

- `bun run --cwd packages/core build` / `bun run --cwd packages/shared build` — pass (env prereq).
- `bun run --cwd packages/cloud/shared typecheck` — pass.
- `bun run --cwd packages/cloud/api typecheck` — pass.
- `bun test --isolate packages/cloud/shared/src/lib/providers/audio packages/cloud/shared/src/lib/services/ai-pricing/audio-generation-pricing.test.ts packages/cloud/shared/src/lib/services/media-model-roster.test.ts packages/cloud/api/__tests__/generate-music-registry.test.ts packages/cloud/api/__tests__/generate-video-credit-leak.test.ts` — 47 pass, 0 fail.
- `bun test --isolate packages/cloud/shared/src/lib/providers packages/cloud/shared/src/lib/services/ai-pricing ... packages/cloud/shared/src/lib/services/__tests__/credits-reconcile.test.ts` — 212 pass, 0 fail.
- `bunx @biomejs/biome check --write <touched files>` — pass.

Route test coverage (`generate-music-registry.test.ts`, real definitions + registry, faithful reconcile ledger): auth 401 before billing; unsupported model 400 before reserve; provider mismatch 400; missing FAL creds 503 before reserve; ElevenLabs without R2 503 before reserve; success settles exactly once to totalCost; pre-settle provider failure refunds to 0; post-settle DB failure NOT refunded (#10278); insufficient credits 402; SFX end-to-end through mocked ElevenLabs upstream with real R2 key-path assertion and `type: "sfx"` generation row.

## N/A

- Live provider calls and generated audio artifacts: N/A — no FAL/ElevenLabs/Suno credentials in this environment; live generated-audio evidence is tracked by the parent issue's live-evidence child (see #11741 scope note).
- UI screenshots/video: N/A — cloud API/shared provider refactor with no dashboard UI changes.
- Live LLM trajectories: N/A — no agent prompt/model behavior changed.
