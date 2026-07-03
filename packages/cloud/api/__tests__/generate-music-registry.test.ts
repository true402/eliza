/**
 * Route regression for POST /api/v1/generate-music after the audio provider
 * registry refactor (#11741).
 *
 * Covers, against the REAL audio model definitions and registry:
 *  - auth: an unauthenticated request never reaches billing;
 *  - validation: unsupported model / provider mismatch rejected before any
 *    credit work;
 *  - fail-closed configuration: missing provider credentials and missing R2
 *    storage 503 BEFORE credit reservation;
 *  - billing: success settles the reservation exactly once to totalCost;
 *    pre-settle provider failure refunds (reconcile(0)); post-settle DB
 *    failure must NOT refund (#10278 semantics);
 *  - insufficient credits → 402;
 *  - SFX path: elevenlabs/sound_effects generates via /v1/sound-generation,
 *    persists bytes to R2 under generations/sfx/..., records type "sfx".
 *
 * The credit ledger reservation is faithful (real reconcile math); upstream
 * providers and persistence are mocked at the module/network boundary.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { ApiError } from "@/lib/api/cloud-worker-errors";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import * as aiPricingActual from "@/lib/services/ai-pricing";
import { SUPPORTED_AUDIO_MODEL_IDS } from "@/lib/services/ai-pricing-definitions";
import * as contentSafetyActual from "@/lib/services/content-safety";
import * as creditsActual from "@/lib/services/credits";
import * as generationsActual from "@/lib/services/generations";

const falActual = require("@fal-ai/client") as Record<string, unknown>;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const MUSIC_MODEL = "fal-ai/minimax-music/v2.6";
const SFX_MODEL = "elevenlabs/sound_effects";
const COST = 0.25;

const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

// rateLimit(preset) returns a Hono middleware; make it a transparent pass-through.
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  ...rateLimitActual,
  RateLimitPresets: { STRICT: { limit: 1, windowSeconds: 1 } },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/services/content-safety", () => ({
  ...contentSafetyActual,
  contentSafetyService: {
    ...contentSafetyActual.contentSafetyService,
    assertSafeForPublicUse: async () => undefined,
  },
}));

mock.module("@/lib/services/ai-pricing", () => ({
  ...aiPricingActual,
  calculateAudioGenerationCostFromCatalog: async () => ({ totalCost: COST }),
}));

const reserve = mock();
mock.module("@/lib/services/credits", () => ({
  ...creditsActual,
  creditsService: { ...creditsActual.creditsService, reserve },
}));

const generationsCreate = mock();
mock.module("@/lib/services/generations", () => ({
  ...generationsActual,
  generationsService: {
    ...generationsActual.generationsService,
    create: generationsCreate,
  },
}));

const subscribe = mock();
mock.module("@fal-ai/client", () => ({
  ...falActual,
  createFalClient: () => ({ subscribe }),
}));

const musicRoute = (await import("../v1/generate-music/route")).default;

const realFetch = globalThis.fetch;

afterAll(() => {
  mock.module("@/lib/auth/workers-hono-auth", () => workersHonoAuthActual);
  mock.module(
    "@/lib/middleware/rate-limit-hono-cloudflare",
    () => rateLimitActual,
  );
  mock.module("@/lib/services/content-safety", () => contentSafetyActual);
  mock.module("@/lib/services/ai-pricing", () => aiPricingActual);
  mock.module("@/lib/services/credits", () => creditsActual);
  mock.module("@/lib/services/generations", () => generationsActual);
  mock.module("@fal-ai/client", () => falActual);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

type AppCtx = { set: (k: string, v: unknown) => void };

/** Faithful credit ledger: reserve debits the hold; reconcile adjusts by hold-actual. */
function makeLedgerReservation(startBalance: number, hold: number) {
  let balance = startBalance - hold;
  let reconcileCalls = 0;
  let lastActual = Number.NaN;
  return {
    startBalance,
    get balance() {
      return balance;
    },
    get reconcileCalls() {
      return reconcileCalls;
    },
    get lastActual() {
      return lastActual;
    },
    reservation: {
      reservedAmount: hold,
      reconcile: async (actualCost: number) => {
        reconcileCalls++;
        lastActual = actualCost;
        balance += hold - actualCost;
        return undefined;
      },
    },
  };
}

const validFalResult = {
  requestId: "req-1",
  audio: {
    url: "https://fal.media/out.mp3",
    content_type: "audio/mpeg",
    file_size: 1234,
  },
};

interface MusicResponseBody {
  success?: boolean;
  id?: string;
  error?: string;
  music?: { url?: string };
  details?: { supportedModels?: string[] };
}

function post(
  body: Record<string, unknown> = { model: MUSIC_MODEL, prompt: "a beat" },
  env: Record<string, unknown> = { FAL_KEY: "fal-test-key" },
) {
  return musicRoute.request(
    "/",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  reserve.mockReset();
  generationsCreate.mockReset();
  subscribe.mockReset();

  requireUserOrApiKeyWithOrg.mockImplementation(async (c: AppCtx) => {
    c.set("apiKeyId", "key-1");
    return {
      id: USER,
      organization_id: ORG,
      organization: { id: ORG, name: "Org", is_active: true },
      is_active: true,
    };
  });
});

describe("generate-music — auth", () => {
  test("unauthenticated requests are rejected before any credit or provider work", async () => {
    requireUserOrApiKeyWithOrg.mockImplementation(async () => {
      throw new ApiError(401, "authentication_required", "Authentication required");
    });

    const res = await post();

    expect(res.status).toBe(401);
    expect(reserve).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe("generate-music — model/provider validation", () => {
  test("unsupported models are rejected before provider or credit work", async () => {
    const res = await post({ model: "not-an-audio-model", prompt: "a beat" });

    expect(res.status).toBe(400);
    expect(reserve).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    const body = (await res.json()) as MusicResponseBody;
    expect(body.error).toBe("Unsupported music model: not-an-audio-model");
    expect(body.details?.supportedModels).toEqual(SUPPORTED_AUDIO_MODEL_IDS);
  });

  test("a provider/model mismatch is rejected before credit work", async () => {
    const res = await post({
      model: MUSIC_MODEL,
      prompt: "a beat",
      provider: "suno",
    });

    expect(res.status).toBe(400);
    expect(reserve).not.toHaveBeenCalled();
    const body = (await res.json()) as MusicResponseBody;
    expect(body.error).toBe(`Model ${MUSIC_MODEL} is served by fal, not suno`);
  });

  test("missing FAL credentials are rejected before credit reservation", async () => {
    const res = await post({ model: MUSIC_MODEL, prompt: "a beat" }, {});

    expect(res.status).toBe(503);
    expect(reserve).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    const body = (await res.json()) as MusicResponseBody;
    expect(body.error).toBe("Fal audio generation is not configured");
  });

  test("an ElevenLabs model without R2 storage is rejected before credit reservation", async () => {
    const res = await post(
      { model: SFX_MODEL, prompt: "door creak" },
      { ELEVENLABS_API_KEY: "xi-key" },
    );

    expect(res.status).toBe(503);
    expect(reserve).not.toHaveBeenCalled();
    const body = (await res.json()) as MusicResponseBody;
    expect(body.error).toBe("R2 storage is not configured");
  });
});

describe("generate-music — billing", () => {
  test("clean success settles the reservation exactly once to totalCost", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribe.mockResolvedValue(validFalResult);
    generationsCreate.mockResolvedValue({ id: "gen-1" });

    const res = await post();

    expect(res.status).toBe(200);
    const body = (await res.json()) as MusicResponseBody;
    expect(body.success).toBe(true);
    expect(body.music?.url).toBe("https://fal.media/out.mp3");
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBeCloseTo(COST, 10);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - COST, 10);
    expect(generationsCreate.mock.calls[0]?.[0]).toMatchObject({
      organization_id: ORG,
      user_id: USER,
      type: "music",
      model: MUSIC_MODEL,
      provider: "fal",
      cost: String(COST),
    });
  });

  test("pre-settle provider failure refunds: reconciled once to 0, balance restored", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribe.mockRejectedValue(new Error("fal upstream 503"));

    const res = await post();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(generationsCreate).not.toHaveBeenCalled();
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBe(0);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
  });

  test("post-settle DB failure must NOT refund: reconciled once to totalCost (#10278)", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribe.mockResolvedValue(validFalResult);
    generationsCreate.mockRejectedValue(new Error("db write failed"));

    const res = await post();

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBeCloseTo(COST, 10);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - COST, 10);
  });

  test("insufficient credits → 402, no provider call", async () => {
    reserve.mockRejectedValue(
      new creditsActual.InsufficientCreditsError(COST, 0),
    );

    const res = await post();

    expect(res.status).toBe(402);
    expect(subscribe).not.toHaveBeenCalled();
    expect(generationsCreate).not.toHaveBeenCalled();
  });
});

describe("generate-music — SFX through the ElevenLabs provider", () => {
  test("elevenlabs/sound_effects generates via sound-generation, stores to R2, records type sfx", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    generationsCreate.mockResolvedValue({ id: "gen-sfx" });

    const fetchMock = mock(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const blobPut = mock(async (_key: string, _body: unknown, _opts: unknown) => undefined);
    const res = await post(
      { model: SFX_MODEL, prompt: "door creak", durationSeconds: 3 },
      { ELEVENLABS_API_KEY: "xi-key", BLOB: { put: blobPut } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as MusicResponseBody;
    expect(body.success).toBe(true);
    expect(body.music?.url).toMatch(
      new RegExp(
        `^https://blob\\.elizacloud\\.ai/generations/sfx/${ORG}/${USER}/[0-9a-f-]+\\.mp3$`,
      ),
    );

    // The upstream call went to the ElevenLabs sound-generation endpoint.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(String(url)).toBe(
      "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      text: "door creak",
      duration_seconds: 3,
    });

    // Bytes were persisted through the R2 binding under the org/user-scoped key.
    expect(blobPut).toHaveBeenCalledTimes(1);
    const blobKey = blobPut.mock.calls[0]?.[0] ?? "";
    expect(blobKey).toStartWith(`generations/sfx/${ORG}/${USER}/`);

    // Billed exactly once at totalCost; recorded as an sfx generation.
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBeCloseTo(COST, 10);
    expect(generationsCreate.mock.calls[0]?.[0]).toMatchObject({
      type: "sfx",
      model: SFX_MODEL,
      provider: "elevenlabs",
    });
  });
});
