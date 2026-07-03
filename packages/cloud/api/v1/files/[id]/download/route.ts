/**
 * GET /api/v1/files/:id/download — authenticated byte access for one org
 * library asset (#11743). Library uploads live under the private `org-files/`
 * R2 prefix, so this route is the ONLY way to read them: auth-gated,
 * org-scoped, with the same stored-XSS headers as the public blob host
 * (nosniff, attachment for active types, sandboxed CSP).
 */

import { Hono } from "hono";
import { z } from "zod";
import { isInlineSafeContentType } from "@/api-app/blob-host";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { nextStyleParams } from "@/lib/api/hono-next-style-params";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { orgFilesService } from "@/lib/services/org-files";
import type { AppEnv } from "@/types/cloud-worker-env";

const ROUTE_PARAM_SPEC = [{ name: "id", splat: false }] as const;
const idSchema = z.string().uuid();

const app = new Hono<AppEnv>();

app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const { id } = await nextStyleParams(c, ROUTE_PARAM_SPEC).params;
    if (!idSchema.safeParse(id).success) {
      return c.json(
        { success: false, error: "A valid file id is required" },
        400,
      );
    }

    const download = await orgFilesService.openDownload(
      user.organization_id,
      id,
    );
    if (!download) {
      return c.json({ success: false, error: "File not found" }, 404);
    }

    const { file, body } = download;
    const disposition = isInlineSafeContentType(file.content_type)
      ? "inline"
      : "attachment";
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": file.content_type,
        "content-length": String(body.byteLength),
        // Filenames are sanitized at write time to a quote-free charset.
        "content-disposition": `${disposition}; filename="${file.filename}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
