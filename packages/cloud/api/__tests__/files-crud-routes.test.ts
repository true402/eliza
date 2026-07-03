/**
 * /api/v1/files CRUD — REAL handlers, REAL service + repository, REAL DB
 * (#11743).
 *
 * Mounts the actual v1/files route modules on a Hono app and drives them
 * end-to-end against in-process PGlite: real `org_files` + `generations`
 * rows, the real OrgFilesService, and an in-memory R2 bucket shim (Workers
 * R2 does not exist under bun test — the shim implements the same
 * RuntimeR2Bucket surface the Worker binding provides).
 *
 * The ONLY seam mocked is `requireUserOrApiKeyWithOrg` (same as
 * org-credentials-routes.test.ts): bearer tokens map to seeded users across
 * TWO orgs so org scoping, cross-org 403-by-404 denial, and auth failure are
 * exercised for real.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { Hono } from "hono";
import { AuthenticationError } from "@/lib/api/cloud-worker-errors";
import * as realAuth from "@/lib/auth/workers-hono-auth";
import {
  type RuntimeR2Bucket,
  setRuntimeR2Bucket,
} from "@/lib/storage/r2-runtime-binding";
import type { AppEnv } from "@/types/cloud-worker-env";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const USER_B = "bbbbbbbb-1111-4111-8111-111111111111";

const TOKENS: Record<string, { id: string; organization_id: string }> = {
  eliza_user_a: { id: USER_A, organization_id: ORG_A },
  eliza_user_b: { id: USER_B, organization_id: ORG_B },
};

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: mock(
    async (c: { req: { header: (n: string) => string | undefined } }) => {
      const bearer =
        c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      const user = TOKENS[bearer];
      if (!user) throw AuthenticationError();
      return { ...user, organization: { id: user.organization_id } };
    },
  ),
}));

const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

const objects = new Map<string, Uint8Array>();

function memoryBucket(): RuntimeR2Bucket {
  return {
    async get(key) {
      const value = objects.get(key);
      if (value === undefined) return null;
      return {
        async text() {
          return new TextDecoder().decode(value);
        },
        async arrayBuffer() {
          return new Uint8Array(value).buffer as ArrayBuffer;
        },
      };
    },
    async put(key, value) {
      let bytes: Uint8Array;
      if (typeof value === "string") bytes = new TextEncoder().encode(value);
      else if (value instanceof Uint8Array) bytes = new Uint8Array(value);
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
      else bytes = new Uint8Array(0);
      objects.set(key, bytes);
      return {};
    },
    async delete(key) {
      objects.delete(key);
      return {};
    },
  };
}

let pgliteReady = true;
let closeDb: (() => Promise<void>) | undefined;
let app: Hono<AppEnv>;
let seededGenerationA = "";
const GENERATION_KEY = `generations/${ORG_A}/masterpiece.png`;

function authed(token: string, init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  };
}

function uploadForm(name: string, contents: BlobPart, type: string): FormData {
  const form = new FormData();
  form.set("file", new File([contents], name, { type }));
  return form;
}

interface FileDto {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  source: string;
  generationId: string | null;
  downloadPath: string;
}

beforeAll(async () => {
  try {
    const { closeDatabaseConnectionsForTests, dbWrite } = await import(
      "@/db/client"
    );
    closeDb = closeDatabaseConnectionsForTests;
    const { organizations } = await import("@/db/schemas/organizations");
    const { users } = await import("@/db/schemas/users");
    const { apiKeys } = await import("@/db/schemas/api-keys");
    const { usageRecords } = await import("@/db/schemas/usage-records");
    const { generations } = await import("@/db/schemas/generations");
    const { orgFiles } = await import("@/db/schemas/org-files");
    const { pushSchema } = await import("@/db/push-schema-for-tests");
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        apiKeys,
        usageRecords,
        generations,
        orgFiles,
      } as never,
      dbWrite as never,
    );
    await apply();

    await dbWrite.insert(organizations).values([
      { id: ORG_A, name: "Org A", slug: "files-org-a" },
      { id: ORG_B, name: "Org B", slug: "files-org-b" },
    ]);
    await dbWrite.insert(users).values([
      {
        id: USER_A,
        email: "a@files.test",
        organization_id: ORG_A,
        steward_user_id: `steward-${USER_A}`,
      },
      {
        id: USER_B,
        email: "b@files.test",
        organization_id: ORG_B,
        steward_user_id: `steward-${USER_B}`,
      },
    ]);

    objects.set(
      GENERATION_KEY,
      new TextEncoder().encode("generated-image-bytes"),
    );
    const [generation] = await dbWrite
      .insert(generations)
      .values({
        organization_id: ORG_A,
        user_id: USER_A,
        type: "image",
        model: "test-model",
        provider: "test-provider",
        prompt: "a masterpiece",
        status: "completed",
        storage_url: `https://blob.elizacloud.ai/${GENERATION_KEY}`,
        mime_type: "image/png",
        file_size: 21n,
      })
      .returning();
    seededGenerationA = generation.id;

    setRuntimeR2Bucket(memoryBucket());

    // Real route modules at their codegen mount paths.
    const collection = (await import("../v1/files/route")).default;
    const item = (await import("../v1/files/[id]/route")).default;
    const download = (await import("../v1/files/[id]/download/route")).default;
    app = new Hono<AppEnv>();
    app.route("/api/v1/files", collection);
    app.route("/api/v1/files/:id", item);
    app.route("/api/v1/files/:id/download", download);
  } catch (error) {
    pgliteReady = false;
    console.error("[files-crud-routes.test] setup failed — failing.", error);
  }
}, 120_000);

afterAll(async () => {
  setRuntimeR2Bucket(null);
  if (closeDb) await closeDb();
  mock.restore();
});

let uploadedId = "";
let uploadedKeyCount = 0;

describe("auth gate", () => {
  test("rejects an unknown bearer with 401", async () => {
    expect(pgliteReady).toBe(true);
    const res = await app.request("/api/v1/files", authed("eliza_nobody"), ENV);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe("authentication_required");
  });
});

describe("POST /api/v1/files — upload", () => {
  test("uploads a file: 201, DTO, private org-scoped storage key", async () => {
    expect(pgliteReady).toBe(true);
    const res = await app.request(
      "/api/v1/files",
      authed("eliza_user_a", {
        method: "POST",
        body: uploadForm("brief.txt", "campaign brief contents", "text/plain"),
      }),
      ENV,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: boolean; file: FileDto };
    uploadedId = body.file.id;
    expect(body.success).toBe(true);
    expect(body.file.filename).toBe("brief.txt");
    // multipart serialization may append ";charset=utf-8" to text parts
    expect(body.file.contentType.startsWith("text/plain")).toBe(true);
    expect(body.file.sizeBytes).toBe(23);
    expect(body.file.source).toBe("upload");
    expect(body.file.downloadPath).toBe(
      `/api/v1/files/${body.file.id}/download`,
    );

    const keys = [...objects.keys()].filter((k) =>
      k.startsWith(`org-files/${ORG_A}/`),
    );
    expect(keys).toHaveLength(1);
    uploadedKeyCount = objects.size;
  });

  test("rejects a request without a file field", async () => {
    const form = new FormData();
    form.set("note", "no file here");
    const res = await app.request(
      "/api/v1/files",
      authed("eliza_user_a", { method: "POST", body: form }),
      ENV,
    );
    expect(res.status).toBe(400);
  });

  test("rejects an oversized upload and stores nothing", async () => {
    const { ORG_FILES_MAX_FILE_SIZE } = await import(
      "@/lib/services/org-files"
    );
    const res = await app.request(
      "/api/v1/files",
      authed("eliza_user_a", {
        method: "POST",
        body: uploadForm(
          "huge.bin",
          new Uint8Array(ORG_FILES_MAX_FILE_SIZE + 1),
          "application/octet-stream",
        ),
      }),
      ENV,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/upload limit/i);
    expect(objects.size).toBe(uploadedKeyCount);
  });

  test("sanitizes path-traversal filenames", async () => {
    const res = await app.request(
      "/api/v1/files",
      authed("eliza_user_a", {
        method: "POST",
        body: uploadForm("../../../etc/passwd", "root:x:0:0", "text/plain"),
      }),
      ENV,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { file: FileDto };
    expect(body.file.filename).toBe("passwd");
    const traversal = [...objects.keys()].find((k) => k.includes(".."));
    expect(traversal).toBeUndefined();
  });
});

describe("POST /api/v1/files — save generation", () => {
  test("imports a completed org generation by reference", async () => {
    const res = await app.request(
      "/api/v1/files",
      authed("eliza_user_a", {
        method: "POST",
        body: JSON.stringify({ generationId: seededGenerationA }),
        headers: { "Content-Type": "application/json" },
      }),
      ENV,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { file: FileDto };
    expect(body.file.source).toBe("generation");
    expect(body.file.generationId).toBe(seededGenerationA);
    expect(body.file.contentType).toBe("image/png");
  });

  test("404s when saving another org's generation", async () => {
    const res = await app.request(
      "/api/v1/files",
      authed("eliza_user_b", {
        method: "POST",
        body: JSON.stringify({ generationId: seededGenerationA }),
        headers: { "Content-Type": "application/json" },
      }),
      ENV,
    );
    expect(res.status).toBe(404);
  });

  test("400s on a malformed JSON body", async () => {
    const res = await app.request(
      "/api/v1/files",
      authed("eliza_user_a", {
        method: "POST",
        body: JSON.stringify({ generationId: "not-a-uuid" }),
        headers: { "Content-Type": "application/json" },
      }),
      ENV,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/files — list", () => {
  test("lists only the caller org's files with pagination metadata", async () => {
    const res = await app.request("/api/v1/files", authed("eliza_user_a"), ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      files: FileDto[];
      pagination: { total: number; limit: number; offset: number };
    };
    expect(body.success).toBe(true);
    expect(body.files.length).toBeGreaterThanOrEqual(3);
    expect(body.pagination.total).toBe(body.files.length);
    expect(body.pagination.limit).toBe(50);

    const other = await app.request(
      "/api/v1/files",
      authed("eliza_user_b"),
      ENV,
    );
    const otherBody = (await other.json()) as { files: FileDto[] };
    expect(otherBody.files).toHaveLength(0);
  });

  test("filters by kind and source", async () => {
    const images = await app.request(
      "/api/v1/files?kind=image",
      authed("eliza_user_a"),
      ENV,
    );
    const imagesBody = (await images.json()) as { files: FileDto[] };
    expect(imagesBody.files.length).toBeGreaterThanOrEqual(1);
    for (const f of imagesBody.files) {
      expect(f.contentType.startsWith("image/")).toBe(true);
    }

    const uploads = await app.request(
      "/api/v1/files?source=upload",
      authed("eliza_user_a"),
      ENV,
    );
    const uploadsBody = (await uploads.json()) as { files: FileDto[] };
    for (const f of uploadsBody.files) expect(f.source).toBe("upload");
  });

  test("400s on an invalid filter", async () => {
    const res = await app.request(
      "/api/v1/files?kind=executable",
      authed("eliza_user_a"),
      ENV,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/files/:id — metadata", () => {
  test("returns the DTO for the owner org", async () => {
    const res = await app.request(
      `/api/v1/files/${uploadedId}`,
      authed("eliza_user_a"),
      ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { file: FileDto };
    expect(body.file.id).toBe(uploadedId);
  });

  test("404s cross-org (gated ≠ owned)", async () => {
    const res = await app.request(
      `/api/v1/files/${uploadedId}`,
      authed("eliza_user_b"),
      ENV,
    );
    expect(res.status).toBe(404);
  });

  test("400s on a malformed id", async () => {
    const res = await app.request(
      "/api/v1/files/not-a-uuid",
      authed("eliza_user_a"),
      ENV,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/files/:id/download", () => {
  test("streams the exact uploaded bytes with hardened headers", async () => {
    const res = await app.request(
      `/api/v1/files/${uploadedId}/download`,
      authed("eliza_user_a"),
      ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("campaign brief contents");
    expect(res.headers.get("content-type")?.startsWith("text/plain")).toBe(
      true,
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // text/plain is not inline-safe → forced download
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="brief.txt"',
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("serves image content inline", async () => {
    const upload = await app.request(
      "/api/v1/files",
      authed("eliza_user_a", {
        method: "POST",
        body: uploadForm("logo.png", "png-bytes", "image/png"),
      }),
      ENV,
    );
    const { file } = (await upload.json()) as { file: FileDto };
    const res = await app.request(
      `/api/v1/files/${file.id}/download`,
      authed("eliza_user_a"),
      ENV,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'inline; filename="logo.png"',
    );
  });

  test("404s cross-org", async () => {
    const res = await app.request(
      `/api/v1/files/${uploadedId}/download`,
      authed("eliza_user_b"),
      ENV,
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/v1/files/:id", () => {
  test("cross-org delete is refused and removes nothing", async () => {
    const res = await app.request(
      `/api/v1/files/${uploadedId}`,
      authed("eliza_user_b", { method: "DELETE" }),
      ENV,
    );
    expect(res.status).toBe(404);
    const still = await app.request(
      `/api/v1/files/${uploadedId}`,
      authed("eliza_user_a"),
      ENV,
    );
    expect(still.status).toBe(200);
  });

  test("deletes an upload (row + object); repeat delete is a clean 404", async () => {
    const before = [...objects.keys()].filter((k) =>
      k.startsWith(`org-files/${ORG_A}/`),
    ).length;

    const res = await app.request(
      `/api/v1/files/${uploadedId}`,
      authed("eliza_user_a", { method: "DELETE" }),
      ENV,
    );
    expect(res.status).toBe(200);

    const after = [...objects.keys()].filter((k) =>
      k.startsWith(`org-files/${ORG_A}/`),
    ).length;
    expect(after).toBe(before - 1);

    const gone = await app.request(
      `/api/v1/files/${uploadedId}`,
      authed("eliza_user_a"),
      ENV,
    );
    expect(gone.status).toBe(404);

    const again = await app.request(
      `/api/v1/files/${uploadedId}`,
      authed("eliza_user_a", { method: "DELETE" }),
      ENV,
    );
    expect(again.status).toBe(404);
  });

  test("deleting a saved generation keeps the generation's object", async () => {
    const list = await app.request(
      "/api/v1/files?source=generation",
      authed("eliza_user_a"),
      ENV,
    );
    const { files } = (await list.json()) as { files: FileDto[] };
    expect(files).toHaveLength(1);

    const res = await app.request(
      `/api/v1/files/${files[0].id}`,
      authed("eliza_user_a", { method: "DELETE" }),
      ENV,
    );
    expect(res.status).toBe(200);
    expect(objects.has(GENERATION_KEY)).toBe(true);
  });
});
