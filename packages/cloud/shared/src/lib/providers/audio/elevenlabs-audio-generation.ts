import type { AudioGenerationRequest, AudioProvider, AudioStorage, GeneratedAudio } from "./types";

const ELEVENLABS_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";

function elevenLabsKey(apiKeys: Record<string, string | undefined>): string | null {
  const key = apiKeys.ELEVENLABS_API_KEY;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

export function contentTypeForOutputFormat(outputFormat: string | undefined): string {
  if (!outputFormat) return "audio/mpeg";
  if (outputFormat.startsWith("pcm_")) return "audio/L16";
  if (outputFormat.startsWith("ulaw_")) return "audio/basic";
  if (outputFormat.startsWith("wav_")) return "audio/wav";
  if (outputFormat.startsWith("mp3_")) return "audio/mpeg";
  return "application/octet-stream";
}

export function extensionForContentType(contentType: string): string {
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("L16") || contentType.includes("pcm")) return "pcm";
  if (contentType.includes("basic")) return "ulaw";
  return "mp3";
}

function requireStorage(request: AudioGenerationRequest): AudioStorage {
  if (!request.storage) {
    throw new Error("R2 storage is not configured");
  }
  return request.storage;
}

function buildElevenLabsEndpoint(request: AudioGenerationRequest, outputFormat: string): URL {
  const path = request.productFamily === "sfx" ? "sound-generation" : "music";
  const url = new URL(`https://api.elevenlabs.io/v1/${path}`);
  url.searchParams.set("output_format", outputFormat);
  return url;
}

function buildElevenLabsBody(request: AudioGenerationRequest): Record<string, unknown> {
  if (request.productFamily === "sfx") {
    return {
      text: request.prompt,
      ...(request.durationSeconds ? { duration_seconds: request.durationSeconds } : {}),
      ...(request.extraInput ?? {}),
    };
  }
  return {
    prompt: request.prompt,
    ...(request.durationSeconds ? { music_length_ms: request.durationSeconds * 1000 } : {}),
    model_id: request.model.replace(/^elevenlabs\//, ""),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.extraInput ?? {}),
  };
}

export async function generateElevenLabsAudio(
  request: AudioGenerationRequest,
): Promise<GeneratedAudio> {
  const key = elevenLabsKey(request.apiKeys);
  if (!key) {
    throw new Error("ElevenLabs audio generation is not configured");
  }
  const storage = requireStorage(request);

  const outputFormat = request.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
  const response = await fetch(buildElevenLabsEndpoint(request, outputFormat), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": key,
    },
    body: JSON.stringify(buildElevenLabsBody(request)),
    signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`ElevenLabs audio generation failed (${response.status}): ${text}`);
  }

  const contentType =
    response.headers.get("content-type") ?? contentTypeForOutputFormat(outputFormat);
  const bytes = await response.arrayBuffer();
  const stored = await storage.put({
    body: bytes,
    contentType,
    extension: extensionForContentType(contentType),
  });

  return {
    audio: {
      url: stored.url,
      file_name: stored.key.split("/").at(-1),
      file_size: bytes.byteLength,
      content_type: contentType,
    },
    raw: { r2Key: stored.key },
  };
}

export const elevenLabsAudioProvider: AudioProvider = {
  billingSource: "elevenlabs",
  displayName: "ElevenLabs",
  capabilities: ["music", "sfx"],
  requiresStorage: true,
  isConfigured(apiKeys) {
    return Boolean(elevenLabsKey(apiKeys));
  },
  generate: generateElevenLabsAudio,
  async healthCheck() {
    return true;
  },
};
