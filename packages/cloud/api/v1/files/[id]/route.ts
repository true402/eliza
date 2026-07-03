/**
 * /api/v1/files/:id — metadata + delete for one org library asset (#11743).
 * Gated ≠ owned: both verbs resolve the row through the caller's org.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { nextStyleParams } from "@/lib/api/hono-next-style-params";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { orgFilesService, toOrgFileDto } from "@/lib/services/org-files";
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

    const file = await orgFilesService.getForOrganization(
      user.organization_id,
      id,
    );
    if (!file) {
      return c.json({ success: false, error: "File not found" }, 404);
    }
    return c.json({ success: true, file: toOrgFileDto(file) });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.delete("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const { id } = await nextStyleParams(c, ROUTE_PARAM_SPEC).params;
    if (!idSchema.safeParse(id).success) {
      return c.json(
        { success: false, error: "A valid file id is required" },
        400,
      );
    }

    const deleted = await orgFilesService.deleteForOrganization(
      user.organization_id,
      id,
    );
    if (!deleted) {
      return c.json({ success: false, error: "File not found" }, 404);
    }
    return c.json({ success: true, message: "File deleted" });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
