/**
 * /api/v1/files — org-scoped managed asset library (#10688 / #11743).
 *
 * GET  — list the org's assets (pagination + kind/source filters).
 * POST — multipart/form-data: upload a file into the library (private R2 key);
 *        application/json { generationId }: save a completed generation into
 *        the library by reference.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { orgFilesService, toOrgFileDto } from "@/lib/services/org-files";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const listQuerySchema = z.object({
  kind: z.enum(["image", "video", "audio", "text", "application"]).optional(),
  source: z.enum(["upload", "generation"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const importBodySchema = z.object({
  generationId: z.string().uuid(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const parsed = listQuerySchema.safeParse({
      kind: c.req.query("kind") || undefined,
      source: c.req.query("source") || undefined,
      limit: c.req.query("limit") || undefined,
      offset: c.req.query("offset") || undefined,
    });
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Validation error",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const { files, total } = await orgFilesService.list(
      user.organization_id,
      parsed.data,
    );
    return c.json({
      success: true,
      files: files.map(toOrgFileDto),
      pagination: {
        total,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const contentType = c.req.header("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.formData().catch(() => null);
      if (!form) {
        return c.json(
          { success: false, error: "Malformed multipart/form-data body" },
          400,
        );
      }
      const file = form.get("file");
      if (!(file instanceof File)) {
        return c.json(
          { success: false, error: 'A "file" form field is required' },
          400,
        );
      }
      const filenameField = form.get("filename");
      const uploaded = await orgFilesService.uploadFile({
        organizationId: user.organization_id,
        userId: user.id,
        filename:
          typeof filenameField === "string" && filenameField.length > 0
            ? filenameField
            : file.name,
        contentType: file.type || "application/octet-stream",
        bytes: await file.arrayBuffer(),
      });
      return c.json({ success: true, file: toOrgFileDto(uploaded) }, 201);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = importBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error:
            'Send multipart/form-data with a "file" field to upload, or JSON { generationId } to save a generation',
          details: parsed.error.issues,
        },
        400,
      );
    }
    const imported = await orgFilesService.importGeneration({
      organizationId: user.organization_id,
      userId: user.id,
      generationId: parsed.data.generationId,
    });
    return c.json({ success: true, file: toOrgFileDto(imported) }, 201);
  } catch (error) {
    logger.error("[FilesRoute] Failed to create library asset", {
      error:
        error instanceof Error ? error.stack || error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
