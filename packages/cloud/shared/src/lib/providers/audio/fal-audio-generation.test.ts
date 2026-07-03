import { describe, expect, mock, test } from "bun:test";
import { SUPPORTED_AUDIO_MODELS } from "../../services/ai-pricing-definitions";
import type { AudioGenerationRequest } from "./types";

const subscribe = mock();
const createFalClient = mock(() => ({ subscribe }));

mock.module("@fal-ai/client", () => ({
  createFalClient,
}));

const { buildFalAudioInput, falAudioProvider, generateFalAudio } = await import(
  "./fal-audio-generation"
);
const { normalizeAudioResult } = await import("./normalize");

function request(overrides: Partial<AudioGenerationRequest> = {}): AudioGenerationRequest {
  return {
    model: "fal-ai/minimax-music/v2.6",
    prompt: "upbeat synthwave",
    productFamily: "music",
    apiKeys: { FAL_KEY: "fal-key" },
    ...overrides,
  };
}

describe("buildFalAudioInput — music", () => {
  test("maps Cloud music request fields to FAL input aliases", () => {
    expect(
      buildFalAudioInput(
        request({
          lyrics: "la la la",
          instrumental: false,
          lyricsOptimizer: false,
          referenceUrl: "https://example.com/ref.mp3",
          durationSeconds: 45,
          audio: { format: "mp3", sampleRate: "44100", bitrate: "128000" },
          extraInput: { style: "retro" },
        }),
      ),
    ).toEqual({
      prompt: "upbeat synthwave",
      lyrics: "la la la",
      is_instrumental: false,
      lyrics_optimizer: false,
      audio_url: "https://example.com/ref.mp3",
      reference_audio_url: "https://example.com/ref.mp3",
      duration: 45,
      duration_seconds: 45,
      seconds_total: 45,
      audio_setting: { sample_rate: "44100", bitrate: "128000", format: "mp3" },
      style: "retro",
    });
  });

  test("defaults lyrics_optimizer on when no lyrics and not instrumental", () => {
    expect(buildFalAudioInput(request())).toEqual({
      prompt: "upbeat synthwave",
      lyrics_optimizer: true,
    });
    expect(buildFalAudioInput(request({ instrumental: true }))).toEqual({
      prompt: "upbeat synthwave",
      is_instrumental: true,
    });
  });
});

describe("buildFalAudioInput — sfx", () => {
  test("maps ElevenLabs sound-effects input to text/duration_seconds", () => {
    expect(
      buildFalAudioInput(
        request({
          model: "fal-ai/elevenlabs/sound-effects",
          prompt: "glass shattering",
          productFamily: "sfx",
          durationSeconds: 4,
        }),
      ),
    ).toEqual({
      text: "glass shattering",
      duration_seconds: 4,
    });
  });

  test("maps Stable Audio input to prompt/seconds_total/seed", () => {
    expect(
      buildFalAudioInput(
        request({
          model: "fal-ai/stable-audio-25/text-to-audio",
          prompt: "rain on a tin roof",
          productFamily: "sfx",
          durationSeconds: 12,
          seed: 7,
        }),
      ),
    ).toEqual({
      prompt: "rain on a tin roof",
      seconds_total: 12,
      seed: 7,
    });
  });

  test("fails closed for an SFX model with no input mapping", () => {
    expect(() =>
      buildFalAudioInput(request({ model: "fal-ai/unknown-sfx-model", productFamily: "sfx" })),
    ).toThrow("No Fal SFX input mapping for model: fal-ai/unknown-sfx-model");
  });

  test("every supported Fal SFX model has an input mapping", () => {
    const falSfxModels = SUPPORTED_AUDIO_MODELS.filter(
      (model) => model.billingSource === "fal" && model.productFamily === "sfx",
    );
    expect(falSfxModels.length).toBeGreaterThan(0);
    for (const model of falSfxModels) {
      const input = buildFalAudioInput(
        request({ model: model.modelId, productFamily: "sfx", durationSeconds: 5 }),
      );
      expect(Object.keys(input).length).toBeGreaterThan(0);
    }
  });
});

describe("normalizeAudioResult", () => {
  test("normalizes direct audio object with request id fallback", () => {
    const normalized = normalizeAudioResult(
      {
        audio: {
          url: "https://fal.media/out.mp3",
          file_name: "out.mp3",
          file_size: 4321,
          content_type: "audio/mpeg",
        },
        status: "completed",
      },
      "queued-id",
    );
    expect(normalized.requestId).toBe("queued-id");
    expect(normalized.status).toBe("completed");
    expect(normalized.audio).toEqual({
      url: "https://fal.media/out.mp3",
      file_name: "out.mp3",
      file_size: 4321,
      content_type: "audio/mpeg",
    });
  });

  test("normalizes audio_file and audio_url fallback shapes", () => {
    expect(
      normalizeAudioResult({ audio_file: { url: "https://fal.media/sfx.wav" } }).audio.url,
    ).toBe("https://fal.media/sfx.wav");
    expect(normalizeAudioResult({ audio_url: "https://cdn.example/out.mp3" }).audio.url).toBe(
      "https://cdn.example/out.mp3",
    );
    expect(
      normalizeAudioResult({ audios: [{ url: "https://cdn.example/a0.mp3" }] }).audio.url,
    ).toBe("https://cdn.example/a0.mp3");
  });

  test("throws when no audio URL can be located", () => {
    expect(() => normalizeAudioResult({ ok: true })).toThrow(
      "Audio provider returned no audio URL",
    );
    expect(() => normalizeAudioResult("nope")).toThrow(
      "Audio provider returned an invalid response",
    );
  });
});

describe("generateFalAudio", () => {
  test("generates through the FAL queue client and normalizes the result", async () => {
    createFalClient.mockClear();
    subscribe.mockReset();
    subscribe.mockImplementation(
      async (_model: string, opts: { onEnqueue?: (id: string) => void }) => {
        opts.onEnqueue?.("queue-42");
        return { audio: { url: "https://fal.media/song.mp3" } };
      },
    );

    const result = await generateFalAudio(request());

    expect(createFalClient).toHaveBeenCalledWith({
      credentials: "fal-key",
      suppressLocalCredentialsWarning: true,
    });
    expect(subscribe.mock.calls[0]?.[0]).toBe("fal-ai/minimax-music/v2.6");
    expect(result.requestId).toBe("queue-42");
    expect(result.audio.url).toBe("https://fal.media/song.mp3");
  });

  test("throws before any upstream call when FAL credentials are missing", async () => {
    subscribe.mockReset();
    await expect(generateFalAudio(request({ apiKeys: {} }))).rejects.toThrow(
      "Fal audio generation is not configured",
    );
    expect(subscribe).not.toHaveBeenCalled();
  });

  test("provider metadata declares billing source and capabilities", () => {
    expect(falAudioProvider.billingSource).toBe("fal");
    expect(falAudioProvider.capabilities).toEqual(["music", "sfx"]);
    expect(falAudioProvider.isConfigured?.({ FAL_API_KEY: "alt-key" })).toBe(true);
    expect(falAudioProvider.isConfigured?.({})).toBe(false);
  });
});
