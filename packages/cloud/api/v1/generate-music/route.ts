import { Hono } from "hono";
import { z } from "zod";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getAudioProvider } from "@/lib/providers/audio/registry";
import type { AudioStorage } from "@/lib/providers/audio/types";
import { calculateAudioGenerationCostFromCatalog } from "@/lib/services/ai-pricing";
import {
  getSupportedAudioModelDefinition,
  SUPPORTED_AUDIO_MODEL_IDS,
} from "@/lib/services/ai-pricing-definitions";
import { contentSafetyService } from "@/lib/services/content-safety";
import {
  creditsService,
  InsufficientCreditsError,
} from "@/lib/services/credits";
import { generationsService } from "@/lib/services/generations";
import { putPublicObject } from "@/lib/storage/r2-public-object";
import { logger } from "@/lib/utils/logger";
import type { AppEnv, Bindings } from "@/types/cloud-worker-env";

const DEFAULT_MUSIC_MODEL = "fal-ai/minimax-music/v2.6";
const MAX_PROMPT_LENGTH = 4100;
const MAX_LYRICS_LENGTH = 3500;

const audioFormatSchema = z.enum(["mp3", "wav", "pcm", "flac"]).optional();
const audioSampleRateSchema = z
  .enum(["16000", "24000", "32000", "44100"])
  .optional();
const audioBitrateSchema = z
  .enum(["32000", "64000", "128000", "256000"])
  .optional();

const musicRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
  model: z.string().trim().default(DEFAULT_MUSIC_MODEL),
  provider: z.enum(["fal", "elevenlabs", "suno"]).optional(),
  lyrics: z.string().max(MAX_LYRICS_LENGTH).optional(),
  lyricsOptimizer: z.boolean().optional(),
  instrumental: z.boolean().optional(),
  durationSeconds: z.coerce.number().int().min(3).max(600).optional(),
  referenceUrl: z.string().trim().url().optional(),
  seed: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
  outputFormat: z.string().trim().max(64).optional(),
  audio: z
    .object({
      format: audioFormatSchema,
      sampleRate: audioSampleRateSchema,
      bitrate: audioBitrateSchema,
    })
    .strict()
    .optional(),
  extraInput: z.record(z.string(), z.unknown()).optional(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

function envString(env: Bindings, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

app.post("/", async (c) => {
  let reservation: Awaited<ReturnType<typeof creditsService.reserve>> | null =
    null;
  // Once the charge is SETTLED, a later (non-critical, post-settle) failure must
  // NOT hit the catch's reconcile(0) — which is non-idempotent and would refund
  // the already-correct charge, giving free audio. Mirrors generate-image.
  let chargeSettled = false;

  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const request = musicRequestSchema.parse(await c.req.json());
    const definition = getSupportedAudioModelDefinition(request.model);
    if (!definition) {
      return jsonError(
        c,
        400,
        `Unsupported music model: ${request.model}`,
        "validation_error",
        {
          supportedModels: SUPPORTED_AUDIO_MODEL_IDS,
        },
      );
    }

    const provider = request.provider ?? definition.provider;
    if (provider !== definition.provider) {
      return jsonError(
        c,
        400,
        `Model ${request.model} is served by ${definition.provider}, not ${provider}`,
        "validation_error",
      );
    }
    if (provider === "fal" && request.prompt.length > 2000) {
      return jsonError(
        c,
        400,
        "Fal music prompts must be 2000 characters or fewer",
        "validation_error",
      );
    }

    const audioProvider = getAudioProvider(
      definition.billingSource,
      definition.productFamily,
    );
    const apiKeys = {
      FAL_KEY: envString(c.env, "FAL_KEY"),
      FAL_API_KEY: envString(c.env, "FAL_API_KEY"),
      ELEVENLABS_API_KEY: envString(c.env, "ELEVENLABS_API_KEY"),
      SUNO_API_KEY: envString(c.env, "SUNO_API_KEY"),
      SUNO_BASE_URL: envString(c.env, "SUNO_BASE_URL"),
    };
    if (audioProvider.isConfigured && !audioProvider.isConfigured(apiKeys)) {
      return jsonError(
        c,
        503,
        `${audioProvider.displayName} audio generation is not configured`,
        "internal_error",
      );
    }
    if (audioProvider.requiresStorage && !c.env.BLOB) {
      return jsonError(
        c,
        503,
        "R2 storage is not configured",
        "internal_error",
      );
    }

    await contentSafetyService.assertSafeForPublicUse({
      surface: "media_generation_prompt",
      organizationId: user.organization_id,
      userId: user.id,
      text: [
        `Music prompt: ${request.prompt}`,
        request.lyrics ? `Lyrics: ${request.lyrics}` : undefined,
        request.referenceUrl
          ? `Reference URL: ${request.referenceUrl}`
          : undefined,
      ],
      metadata: {
        type: definition.productFamily,
        model: request.model,
        provider,
      },
    });

    const durationSeconds =
      request.durationSeconds ?? definition.defaultParameters.durationSeconds;
    const cost = await calculateAudioGenerationCostFromCatalog({
      model: request.model,
      provider: definition.provider,
      billingSource: definition.billingSource,
      durationSeconds,
      dimensions: {
        ...(durationSeconds ? { durationSeconds } : {}),
        ...(request.instrumental !== undefined
          ? { instrumental: request.instrumental }
          : {}),
      },
    });

    try {
      reservation = await creditsService.reserve({
        organizationId: user.organization_id,
        userId: user.id,
        amount: cost.totalCost,
        description: `${definition.productFamily === "sfx" ? "Sound effect" : "Music"} generation: ${request.model}`,
      });
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return c.json(
          {
            success: false,
            error: "Insufficient credits",
            required: error.required,
          },
          402,
        );
      }
      throw error;
    }

    const organizationId = user.organization_id ?? "unknown";
    const storage: AudioStorage | undefined = c.env.BLOB
      ? {
          put: async ({ body, contentType, extension }) => {
            const key = `generations/${definition.productFamily}/${organizationId}/${user.id}/${crypto.randomUUID()}.${extension}`;
            return await putPublicObject(c.env, {
              key,
              body,
              contentType,
              customMetadata: {
                userId: user.id,
                organizationId,
                model: request.model,
                source: "generate-music",
              },
            });
          },
        }
      : undefined;

    const normalized = await audioProvider.generate({
      ...request,
      productFamily: definition.productFamily,
      apiKeys,
      storage,
    });

    await reservation.reconcile(cost.totalCost);
    chargeSettled = true;

    const generation = await generationsService.create({
      organization_id: user.organization_id,
      user_id: user.id,
      type: definition.productFamily,
      model: request.model,
      provider: definition.provider,
      prompt: request.prompt,
      result: {
        requestId: normalized.requestId,
        status: normalized.status,
        billingSource: definition.billingSource,
        raw: normalized.raw,
      },
      status: "completed",
      storage_url: normalized.audio.url,
      thumbnail_url: null,
      file_size: normalized.audio.file_size
        ? BigInt(normalized.audio.file_size)
        : undefined,
      mime_type: normalized.audio.content_type ?? "audio/mpeg",
      parameters: {
        durationSeconds,
        hasLyrics: Boolean(request.lyrics),
        lyricsOptimizer: request.lyricsOptimizer,
        instrumental: request.instrumental,
        referenceUrl: request.referenceUrl,
        outputFormat: request.outputFormat,
      },
      dimensions: {
        duration: durationSeconds,
      },
      cost: String(cost.totalCost),
      credits: String(cost.totalCost),
      job_id: normalized.requestId,
      completed_at: new Date(),
    });

    return c.json({
      success: true,
      id: generation.id,
      requestId: normalized.requestId,
      status: normalized.status ?? "completed",
      music: normalized.audio,
      cost,
    });
  } catch (error) {
    if (reservation && !chargeSettled) {
      await reservation.reconcile(0).catch((reconcileError) => {
        logger.error("[GenerateMusic] Failed to refund reservation", {
          error:
            reconcileError instanceof Error
              ? reconcileError.message
              : String(reconcileError),
        });
      });
    }
    return failureResponse(c, error);
  }
});

app.all("*", (c) =>
  c.json({ success: false, error: "Method not allowed" }, 405),
);

export default app;
