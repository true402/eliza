import { afterEach, describe, expect, mock, test } from "bun:test";
import { buildSunoBody, generateSunoAudio, sunoAudioProvider } from "./suno-audio-generation";
import type { AudioGenerationRequest } from "./types";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function request(overrides: Partial<AudioGenerationRequest> = {}): AudioGenerationRequest {
  return {
    model: "suno/default",
    prompt: "lofi beats",
    productFamily: "music",
    apiKeys: { SUNO_API_KEY: "suno-key" },
    ...overrides,
  };
}

describe("buildSunoBody", () => {
  test("maps request fields to the Suno-compatible body", () => {
    expect(
      buildSunoBody(
        request({
          durationSeconds: 90,
          lyrics: "verse one",
          instrumental: false,
          extraInput: { style: "jazz" },
        }),
      ),
    ).toEqual({
      prompt: "lofi beats",
      duration: 90,
      lyrics: "verse one",
      instrumental: false,
      style: "jazz",
    });
  });
});

describe("generateSunoAudio", () => {
  test("posts to the default base URL and normalizes the response", async () => {
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            id: "suno-1",
            status: "complete",
            audio_url: "https://cdn.suno/out.mp3",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateSunoAudio(request());

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.suno.ai/v1/generate");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer suno-key");
    expect(result.requestId).toBe("suno-1");
    expect(result.status).toBe("complete");
    expect(result.audio.url).toBe("https://cdn.suno/out.mp3");
  });

  test("uses SUNO_BASE_URL with trailing slashes stripped", async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ audio_url: "https://cdn.other/out.mp3" }), {
          status: 200,
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await generateSunoAudio(
      request({
        apiKeys: { SUNO_API_KEY: "suno-key", SUNO_BASE_URL: "https://proxy.example/v2//" },
      }),
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://proxy.example/v2/generate");
  });

  test("throws with upstream status on failure", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ error: "bad" }), { status: 502 }),
    ) as unknown as typeof fetch;

    await expect(generateSunoAudio(request())).rejects.toThrow(
      "Suno-compatible audio generation failed (502)",
    );
  });

  test("throws before any upstream call when the API key is missing", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(generateSunoAudio(request({ apiKeys: {} }))).rejects.toThrow(
      "Suno-compatible audio generation is not configured",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("provider metadata declares music-only capability", () => {
    expect(sunoAudioProvider.billingSource).toBe("suno");
    expect(sunoAudioProvider.capabilities).toEqual(["music"]);
    expect(sunoAudioProvider.requiresStorage).toBeUndefined();
  });
});
