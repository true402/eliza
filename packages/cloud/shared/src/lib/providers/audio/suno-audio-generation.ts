import { normalizeAudioResult } from "./normalize";
import type { AudioGenerationRequest, AudioProvider, GeneratedAudio } from "./types";

const SUNO_TIMEOUT_MS = 120_000;
const DEFAULT_SUNO_BASE_URL = "https://api.suno.ai/v1";

function sunoKey(apiKeys: Record<string, string | undefined>): string | null {
  const key = apiKeys.SUNO_API_KEY;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

function sunoBaseUrl(apiKeys: Record<string, string | undefined>): string {
  const base = apiKeys.SUNO_BASE_URL;
  const value = typeof base === "string" && base.trim() ? base.trim() : DEFAULT_SUNO_BASE_URL;
  return value.replace(/\/+$/, "");
}

export function buildSunoBody(request: AudioGenerationRequest): Record<string, unknown> {
  return {
    prompt: request.prompt,
    ...(request.durationSeconds ? { duration: request.durationSeconds } : {}),
    ...(request.lyrics ? { lyrics: request.lyrics } : {}),
    ...(request.instrumental !== undefined ? { instrumental: request.instrumental } : {}),
    ...(request.extraInput ?? {}),
  };
}

export async function generateSunoAudio(request: AudioGenerationRequest): Promise<GeneratedAudio> {
  const key = sunoKey(request.apiKeys);
  if (!key) {
    throw new Error("Suno-compatible audio generation is not configured");
  }

  const response = await fetch(`${sunoBaseUrl(request.apiKeys)}/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildSunoBody(request)),
    signal: AbortSignal.timeout(SUNO_TIMEOUT_MS),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Suno-compatible audio generation failed (${response.status})`);
  }
  return normalizeAudioResult(data);
}

export const sunoAudioProvider: AudioProvider = {
  billingSource: "suno",
  displayName: "Suno-compatible",
  capabilities: ["music"],
  isConfigured(apiKeys) {
    return Boolean(sunoKey(apiKeys));
  },
  generate: generateSunoAudio,
  async healthCheck() {
    return true;
  },
};
