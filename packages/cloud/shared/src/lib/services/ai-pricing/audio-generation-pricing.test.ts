/**
 * Every SUPPORTED_AUDIO_MODELS entry MUST have a `music:generation` or
 * `sfx:generation` pricing row in its billing source's snapshot, or
 * /v1/generate-music 500s "Pricing unavailable" at the cost estimate BEFORE
 * dispatch (the same failure mode as #11005 for images).
 *
 * Deliberately NO `mock.module` here: bun module mocks are process-global and
 * last-writer-wins across test files, so this file asserts against the real
 * static snapshot builder directly — no DB, no network, no leakage.
 */
import { expect, test } from "bun:test";
import { SUPPORTED_AUDIO_MODELS } from "../ai-pricing-definitions";

const { buildAudioSnapshotEntries } = await import("./providers/suno");

test("every supported audio model has a generation pricing row for its product family", () => {
  const rows = buildAudioSnapshotEntries();
  expect(SUPPORTED_AUDIO_MODELS.length).toBeGreaterThan(0);

  for (const model of SUPPORTED_AUDIO_MODELS) {
    const row = rows.find(
      (candidate) =>
        candidate.model === model.modelId && candidate.billingSource === model.billingSource,
    );
    expect(row, `${model.modelId} has no snapshot pricing row`).toBeDefined();
    expect(row?.productFamily).toBe(model.productFamily);
    expect(row?.chargeType).toBe("generation");
    expect(row?.unitPrice ?? 0).toBeGreaterThan(0);
  }
});

test("snapshot rows filter by billing source for the per-source catalog builders", () => {
  const falRows = buildAudioSnapshotEntries("fal", "fal_model_page");
  expect(falRows.length).toBeGreaterThan(0);
  for (const row of falRows) {
    expect(row.billingSource).toBe("fal");
    expect(row.sourceKind).toBe("fal_model_page");
  }

  const sfxRows = buildAudioSnapshotEntries().filter((row) => row.productFamily === "sfx");
  expect(sfxRows.length).toBeGreaterThanOrEqual(3);
});
