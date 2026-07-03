import { describe, expect, test } from "bun:test";
import { SUPPORTED_AUDIO_MODELS } from "../../services/ai-pricing-definitions";
import { getAudioProvider } from "./registry";

describe("audio provider registry", () => {
  test("resolves each built-in provider by billing source", () => {
    expect(getAudioProvider("fal", "music").displayName).toBe("Fal");
    expect(getAudioProvider("fal", "sfx").displayName).toBe("Fal");
    expect(getAudioProvider("elevenlabs", "music").displayName).toBe("ElevenLabs");
    expect(getAudioProvider("elevenlabs", "sfx").displayName).toBe("ElevenLabs");
    expect(getAudioProvider("suno", "music").displayName).toBe("Suno-compatible");
  });

  test("fails closed for a billing source with no registered provider", () => {
    expect(() => getAudioProvider("gateway", "music")).toThrow(
      "No audio provider registered for billing source: gateway",
    );
  });

  test("fails closed when the provider lacks the requested capability", () => {
    expect(() => getAudioProvider("suno", "sfx")).toThrow(
      "Audio provider for billing source suno does not support sfx generation",
    );
  });

  test("every supported audio model resolves a provider with its capability", () => {
    expect(SUPPORTED_AUDIO_MODELS.length).toBeGreaterThan(0);
    for (const definition of SUPPORTED_AUDIO_MODELS) {
      const provider = getAudioProvider(definition.billingSource, definition.productFamily);
      expect(provider.billingSource).toBe(definition.billingSource);
      expect(provider.capabilities).toContain(definition.productFamily);
    }
  });
});
