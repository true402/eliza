import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  contentTypeForOutputFormat,
  elevenLabsAudioProvider,
  extensionForContentType,
  generateElevenLabsAudio,
} from "./elevenlabs-audio-generation";
import type { AudioGenerationRequest, AudioStorage } from "./types";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function storageMock() {
  const put = mock(async () => ({
    url: "https://blob.example/generations/audio/key.mp3",
    key: "generations/audio/key.mp3",
  }));
  const storage: AudioStorage = { put };
  return { storage, put };
}

function request(overrides: Partial<AudioGenerationRequest> = {}): AudioGenerationRequest {
  return {
    model: "elevenlabs/music_v1",
    prompt: "calm piano",
    productFamily: "music",
    apiKeys: { ELEVENLABS_API_KEY: "xi-key" },
    ...overrides,
  };
}

function okAudioResponse(bytes: Uint8Array, contentType = "audio/mpeg"): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": contentType } });
}

describe("generateElevenLabsAudio — music", () => {
  test("posts to /v1/music and persists returned bytes through storage", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = mock(async () => okAudioResponse(bytes));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { storage, put } = storageMock();

    const result = await generateElevenLabsAudio(
      request({ storage, durationSeconds: 30, seed: 11 }),
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("xi-key");
    expect(JSON.parse(String(init.body))).toEqual({
      prompt: "calm piano",
      music_length_ms: 30_000,
      model_id: "music_v1",
      seed: 11,
    });

    expect(put).toHaveBeenCalledTimes(1);
    const putArgs = put.mock.calls[0]?.[0] as unknown as {
      body: ArrayBuffer;
      contentType: string;
      extension: string;
    };
    expect(putArgs.contentType).toBe("audio/mpeg");
    expect(putArgs.extension).toBe("mp3");
    expect(new Uint8Array(putArgs.body)).toEqual(bytes);

    expect(result.audio.url).toBe("https://blob.example/generations/audio/key.mp3");
    expect(result.audio.file_size).toBe(4);
    expect(result.raw).toEqual({ r2Key: "generations/audio/key.mp3" });
  });
});

describe("generateElevenLabsAudio — sound effects", () => {
  test("posts to /v1/sound-generation with text and duration_seconds", async () => {
    const fetchMock = mock(async () => okAudioResponse(new Uint8Array([9])));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { storage } = storageMock();

    await generateElevenLabsAudio(
      request({
        model: "elevenlabs/sound_effects",
        prompt: "door creak",
        productFamily: "sfx",
        durationSeconds: 3,
        storage,
      }),
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(
      "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      text: "door creak",
      duration_seconds: 3,
    });
  });
});

describe("generateElevenLabsAudio — failure modes", () => {
  test("throws with upstream status when ElevenLabs rejects the request", async () => {
    globalThis.fetch = mock(
      async () => new Response("quota exceeded", { status: 429 }),
    ) as unknown as typeof fetch;
    const { storage, put } = storageMock();

    await expect(generateElevenLabsAudio(request({ storage }))).rejects.toThrow(
      "ElevenLabs audio generation failed (429): quota exceeded",
    );
    expect(put).not.toHaveBeenCalled();
  });

  test("throws before any upstream call when the API key is missing", async () => {
    const fetchMock = mock(async () => okAudioResponse(new Uint8Array()));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { storage } = storageMock();

    await expect(generateElevenLabsAudio(request({ apiKeys: {}, storage }))).rejects.toThrow(
      "ElevenLabs audio generation is not configured",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("throws before any upstream call when storage is missing", async () => {
    const fetchMock = mock(async () => okAudioResponse(new Uint8Array()));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(generateElevenLabsAudio(request())).rejects.toThrow(
      "R2 storage is not configured",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("output format mapping", () => {
  test("maps output formats to content types and extensions", () => {
    expect(contentTypeForOutputFormat(undefined)).toBe("audio/mpeg");
    expect(contentTypeForOutputFormat("wav_44100")).toBe("audio/wav");
    expect(contentTypeForOutputFormat("pcm_16000")).toBe("audio/L16");
    expect(contentTypeForOutputFormat("ulaw_8000")).toBe("audio/basic");
    expect(contentTypeForOutputFormat("weird")).toBe("application/octet-stream");
    expect(extensionForContentType("audio/wav")).toBe("wav");
    expect(extensionForContentType("audio/L16")).toBe("pcm");
    expect(extensionForContentType("audio/basic")).toBe("ulaw");
    expect(extensionForContentType("audio/mpeg")).toBe("mp3");
  });

  test("provider metadata requires storage and declares capabilities", () => {
    expect(elevenLabsAudioProvider.billingSource).toBe("elevenlabs");
    expect(elevenLabsAudioProvider.capabilities).toEqual(["music", "sfx"]);
    expect(elevenLabsAudioProvider.requiresStorage).toBe(true);
    expect(elevenLabsAudioProvider.isConfigured?.({ ELEVENLABS_API_KEY: "k" })).toBe(true);
    expect(elevenLabsAudioProvider.isConfigured?.({})).toBe(false);
  });
});
