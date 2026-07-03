import { createFalClient } from "@fal-ai/client";
import { normalizeAudioResult } from "./normalize";
import type { AudioGenerationRequest, AudioProvider, GeneratedAudio } from "./types";

function falKey(apiKeys: Record<string, string | undefined>): string | null {
  const key = apiKeys.FAL_KEY ?? apiKeys.FAL_API_KEY;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

/**
 * SFX endpoints have their own input schemas — a music-shaped payload would be
 * rejected upstream. Keyed statically by model id; a supported SFX model with
 * no builder here is a wiring bug and fails closed before any upstream call.
 */
const FAL_SFX_INPUT_BUILDERS: Record<
  string,
  (request: AudioGenerationRequest) => Record<string, unknown>
> = {
  "fal-ai/elevenlabs/sound-effects": (request) => ({
    text: request.prompt,
    ...(request.durationSeconds ? { duration_seconds: request.durationSeconds } : {}),
    ...(request.extraInput ?? {}),
  }),
  "fal-ai/stable-audio-25/text-to-audio": (request) => ({
    prompt: request.prompt,
    ...(request.durationSeconds ? { seconds_total: request.durationSeconds } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.extraInput ?? {}),
  }),
};

function buildFalMusicInput(request: AudioGenerationRequest): Record<string, unknown> {
  const input: Record<string, unknown> = {
    prompt: request.prompt,
  };

  if (request.lyrics !== undefined) input.lyrics = request.lyrics;
  if (request.instrumental !== undefined) input.is_instrumental = request.instrumental;
  if (request.lyricsOptimizer !== undefined) {
    input.lyrics_optimizer = request.lyricsOptimizer;
  } else if (!request.lyrics && request.instrumental !== true) {
    input.lyrics_optimizer = true;
  }
  if (request.referenceUrl) {
    input.audio_url = request.referenceUrl;
    input.reference_audio_url = request.referenceUrl;
  }
  if (request.durationSeconds) {
    input.duration = request.durationSeconds;
    input.duration_seconds = request.durationSeconds;
    input.seconds_total = request.durationSeconds;
  }
  if (request.audio) {
    input.audio_setting = {
      ...(request.audio.sampleRate ? { sample_rate: request.audio.sampleRate } : {}),
      ...(request.audio.bitrate ? { bitrate: request.audio.bitrate } : {}),
      ...(request.audio.format ? { format: request.audio.format } : {}),
    };
  }

  return {
    ...input,
    ...(request.extraInput ?? {}),
  };
}

export function buildFalAudioInput(request: AudioGenerationRequest): Record<string, unknown> {
  if (request.productFamily === "sfx") {
    const buildSfxInput = FAL_SFX_INPUT_BUILDERS[request.model];
    if (!buildSfxInput) {
      throw new Error(`No Fal SFX input mapping for model: ${request.model}`);
    }
    return buildSfxInput(request);
  }
  return buildFalMusicInput(request);
}

export async function generateFalAudio(request: AudioGenerationRequest): Promise<GeneratedAudio> {
  const key = falKey(request.apiKeys);
  if (!key) {
    throw new Error("Fal audio generation is not configured");
  }

  let requestId: string | undefined;
  const fal = createFalClient({
    credentials: key,
    suppressLocalCredentialsWarning: true,
  });
  const result = await fal.subscribe(request.model, {
    input: buildFalAudioInput(request),
    onEnqueue: (id) => {
      requestId = id;
    },
  });
  return normalizeAudioResult(result, requestId);
}

export const falAudioProvider: AudioProvider = {
  billingSource: "fal",
  displayName: "Fal",
  capabilities: ["music", "sfx"],
  isConfigured(apiKeys) {
    return Boolean(falKey(apiKeys));
  },
  generate: generateFalAudio,
  async healthCheck() {
    return true;
  },
};
