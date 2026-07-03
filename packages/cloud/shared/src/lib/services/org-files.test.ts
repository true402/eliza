/**
 * OrgFilesService + OrgFilesRepository — real Drizzle schema on in-process
 * PGlite + in-memory R2 shim (#11743).
 *
 * Harness mirrors app-frontend-deployments.test.ts: `pushSchema`
 * (drizzle-kit/api) applies the REAL `org_files` / `generations` schema
 * (including the partial-unique generation index) to the same `dbWrite`
 * PGlite connection, so every assertion exercises the real SQL. The only
 * shim is the R2 bucket binding — Workers R2 does not exist under bun test.
 *
 * Run:
 *   bun test packages/cloud/shared/src/lib/services/org-files.test.ts
 *
 * Self-skips LOUDLY if PGlite/pushSchema can't apply here (never silently passes).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { orgFilesRepository } from "../../db/repositories/org-files";
import { apiKeys } from "../../db/schemas/api-keys";
import { generations } from "../../db/schemas/generations";
import { orgFiles } from "../../db/schemas/org-files";
import { organizations } from "../../db/schemas/organizations";
import { usageRecords } from "../../db/schemas/usage-records";
import { users } from "../../db/schemas/users";
import { ApiError } from "../api/cloud-worker-errors";
import { type RuntimeR2Bucket, setRuntimeR2Bucket } from "../storage/r2-runtime-binding";
import {
  ORG_FILES_KEY_PREFIX,
  ORG_FILES_MAX_FILE_SIZE,
  orgFilesService,
  sanitizeOrgFileFilename,
  toOrgFileDto,
} from "./org-files";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

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

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

let orgA = "";
let orgB = "";
let userA = "";
let userB = "";

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

async function seedGeneration(params: {
  organizationId: string;
  status: string;
  storageUrl: string | null;
  mimeType?: string;
  fileSize?: bigint;
}): Promise<string> {
  const [row] = await dbWrite
    .insert(generations)
    .values({
      organization_id: params.organizationId,
      type: "image",
      model: "test-model",
      provider: "test-provider",
      prompt: "a test prompt",
      status: params.status,
      storage_url: params.storageUrl,
      mime_type: params.mimeType ?? "image/png",
      file_size: params.fileSize,
    })
    .returning();
  return row.id;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[org-files.test] DATABASE_URL is a non-PGlite Postgres; this in-process-PGlite isolation suite self-skips.",
    );
    return;
  }
  try {
    const schema = { organizations, users, apiKeys, usageRecords, generations, orgFiles };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();

    const [oa] = await dbWrite
      .insert(organizations)
      .values({ name: "Org A", slug: uniq("org-a") })
      .returning();
    const [ob] = await dbWrite
      .insert(organizations)
      .values({ name: "Org B", slug: uniq("org-b") })
      .returning();
    orgA = oa.id;
    orgB = ob.id;
    const [ua] = await dbWrite
      .insert(users)
      .values({ steward_user_id: uniq("steward-a"), organization_id: orgA })
      .returning();
    const [ub] = await dbWrite
      .insert(users)
      .values({ steward_user_id: uniq("steward-b"), organization_id: orgB })
      .returning();
    userA = ua.id;
    userB = ub.id;

    setRuntimeR2Bucket(memoryBucket());
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[org-files.test] PGlite/pushSchema unavailable — cannot drive the service against a real DB. Skipping.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  setRuntimeR2Bucket(null);
  await closeDatabaseConnectionsForTests();
});

describe("sanitizeOrgFileFilename", () => {
  test("strips path components and unsafe characters", () => {
    expect(sanitizeOrgFileFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeOrgFileFilename("C:\\Users\\x\\report.pdf")).toBe("report.pdf");
    expect(sanitizeOrgFileFilename('we"ird<na>me?.png')).toBe("we_ird_na_me_.png");
    expect(sanitizeOrgFileFilename("...")).toBe("file");
    expect(sanitizeOrgFileFilename("")).toBe("file");
  });
});

describe("uploadFile", () => {
  test("stores private bytes + metadata row and returns a DTO with a download path", async () => {
    expect(pgliteReady).toBe(true);
    const file = await orgFilesService.uploadFile({
      organizationId: orgA,
      userId: userA,
      filename: "hello.txt",
      contentType: "text/plain",
      bytes: bytesOf("hello world"),
    });

    expect(file.organization_id).toBe(orgA);
    expect(file.user_id).toBe(userA);
    expect(file.filename).toBe("hello.txt");
    expect(file.content_type).toBe("text/plain");
    expect(file.size_bytes).toBe(11);
    expect(file.source).toBe("upload");
    expect(file.storage_key).toBe(`${ORG_FILES_KEY_PREFIX}/${orgA}/${file.id}/hello.txt`);
    expect(file.storage_key.startsWith("org-files/")).toBe(true);
    expect(objects.has(file.storage_key)).toBe(true);
    expect(new TextDecoder().decode(objects.get(file.storage_key))).toBe("hello world");

    const dto = toOrgFileDto(file);
    expect(dto.downloadPath).toBe(`/api/v1/files/${file.id}/download`);
    expect(dto.sizeBytes).toBe(11);
  });

  test("rejects an empty upload", async () => {
    expect(pgliteReady).toBe(true);
    await expect(
      orgFilesService.uploadFile({
        organizationId: orgA,
        userId: userA,
        filename: "empty.bin",
        contentType: "application/octet-stream",
        bytes: new ArrayBuffer(0),
      }),
    ).rejects.toThrow(/empty/i);
  });

  test("rejects an oversized upload and stores nothing", async () => {
    expect(pgliteReady).toBe(true);
    const before = objects.size;
    const oversized = new ArrayBuffer(ORG_FILES_MAX_FILE_SIZE + 1);
    await expect(
      orgFilesService.uploadFile({
        organizationId: orgA,
        userId: userA,
        filename: "huge.bin",
        contentType: "application/octet-stream",
        bytes: oversized,
      }),
    ).rejects.toThrow(/upload limit/i);
    expect(objects.size).toBe(before);
    const { files } = await orgFilesService.list(orgA, { limit: 100, offset: 0 });
    expect(files.find((f) => f.filename === "huge.bin")).toBeUndefined();
  });

  test("reclaims the stored object when the metadata insert fails", async () => {
    expect(pgliteReady).toBe(true);
    const before = objects.size;
    await expect(
      orgFilesService.uploadFile({
        organizationId: "00000000-0000-4000-8000-00000000dead", // FK violation: org does not exist
        userId: userA,
        filename: "orphan.txt",
        contentType: "text/plain",
        bytes: bytesOf("orphan"),
      }),
    ).rejects.toThrow();
    expect(objects.size).toBe(before);
  });
});

describe("list — org scoping, filters, pagination", () => {
  test("only returns the caller org's files, newest first", async () => {
    expect(pgliteReady).toBe(true);
    const mine = await orgFilesService.uploadFile({
      organizationId: orgA,
      userId: userA,
      filename: "mine.png",
      contentType: "image/png",
      bytes: bytesOf("png-bytes"),
    });
    const theirs = await orgFilesService.uploadFile({
      organizationId: orgB,
      userId: userB,
      filename: "theirs.png",
      contentType: "image/png",
      bytes: bytesOf("png-bytes-b"),
    });

    const a = await orgFilesService.list(orgA, { limit: 100, offset: 0 });
    expect(a.files.some((f) => f.id === mine.id)).toBe(true);
    expect(a.files.some((f) => f.id === theirs.id)).toBe(false);

    const b = await orgFilesService.list(orgB, { limit: 100, offset: 0 });
    expect(b.files.some((f) => f.id === theirs.id)).toBe(true);
    expect(b.files.some((f) => f.id === mine.id)).toBe(false);
    expect(b.total).toBe(b.files.length);
  });

  test("filters by MIME kind and paginates", async () => {
    expect(pgliteReady).toBe(true);
    const images = await orgFilesService.list(orgA, { kind: "image", limit: 100, offset: 0 });
    expect(images.files.length).toBeGreaterThanOrEqual(1);
    for (const f of images.files) expect(f.content_type.startsWith("image/")).toBe(true);

    const texts = await orgFilesService.list(orgA, { kind: "text", limit: 100, offset: 0 });
    for (const f of texts.files) expect(f.content_type.startsWith("text/")).toBe(true);

    const all = await orgFilesService.list(orgA, { limit: 100, offset: 0 });
    const page1 = await orgFilesService.list(orgA, { limit: 1, offset: 0 });
    const page2 = await orgFilesService.list(orgA, { limit: 1, offset: 1 });
    expect(page1.files).toHaveLength(1);
    expect(page2.files).toHaveLength(1);
    expect(page1.files[0].id).not.toBe(page2.files[0].id);
    expect(page1.total).toBe(all.total);
    // newest first
    expect([page1.files[0].id, page2.files[0].id]).toEqual([all.files[0].id, all.files[1].id]);
  });
});

describe("importGeneration", () => {
  test("saves a completed org-owned generation by reference, idempotently", async () => {
    expect(pgliteReady).toBe(true);
    const key = `generations/${orgA}/imported-art.png`;
    objects.set(key, new TextEncoder().encode("generated-bytes"));
    const generationId = await seedGeneration({
      organizationId: orgA,
      status: "completed",
      storageUrl: `https://blob.elizacloud.ai/${key}`,
      fileSize: 15n,
    });

    const imported = await orgFilesService.importGeneration({
      organizationId: orgA,
      userId: userA,
      generationId,
    });
    expect(imported.source).toBe("generation");
    expect(imported.generation_id).toBe(generationId);
    expect(imported.storage_key).toBe(key);
    expect(imported.filename).toBe("imported-art.png");
    expect(imported.content_type).toBe("image/png");
    expect(imported.size_bytes).toBe(15);

    const again = await orgFilesService.importGeneration({
      organizationId: orgA,
      userId: userA,
      generationId,
    });
    expect(again.id).toBe(imported.id);

    const { total } = await orgFilesService.list(orgA, {
      source: "generation",
      limit: 100,
      offset: 0,
    });
    expect(total).toBe(1);
  });

  test("measures object bytes when the generation row lacks file_size", async () => {
    expect(pgliteReady).toBe(true);
    const key = `generations/${orgA}/no-size.png`;
    objects.set(key, new TextEncoder().encode("12345678"));
    const generationId = await seedGeneration({
      organizationId: orgA,
      status: "completed",
      storageUrl: `https://blob.elizacloud.ai/${key}`,
    });
    const imported = await orgFilesService.importGeneration({
      organizationId: orgA,
      userId: userA,
      generationId,
    });
    expect(imported.size_bytes).toBe(8);
  });

  test("404s for another org's generation", async () => {
    expect(pgliteReady).toBe(true);
    const generationId = await seedGeneration({
      organizationId: orgB,
      status: "completed",
      storageUrl: "https://blob.elizacloud.ai/generations/b/asset.png",
      fileSize: 1n,
    });
    let thrown: unknown;
    try {
      await orgFilesService.importGeneration({ organizationId: orgA, userId: userA, generationId });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(404);
  });

  test("422s for a generation without a stored asset", async () => {
    expect(pgliteReady).toBe(true);
    const generationId = await seedGeneration({
      organizationId: orgA,
      status: "pending",
      storageUrl: null,
    });
    let thrown: unknown;
    try {
      await orgFilesService.importGeneration({ organizationId: orgA, userId: userA, generationId });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(422);
  });

  test("422s for a storage_url on an untrusted host", async () => {
    expect(pgliteReady).toBe(true);
    const generationId = await seedGeneration({
      organizationId: orgA,
      status: "completed",
      storageUrl: "https://evil.example.com/generations/x.png",
      fileSize: 1n,
    });
    let thrown: unknown;
    try {
      await orgFilesService.importGeneration({ organizationId: orgA, userId: userA, generationId });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(422);
  });
});

describe("openDownload", () => {
  test("returns the exact stored bytes for the owning org only", async () => {
    expect(pgliteReady).toBe(true);
    const file = await orgFilesService.uploadFile({
      organizationId: orgA,
      userId: userA,
      filename: "roundtrip.bin",
      contentType: "application/octet-stream",
      bytes: bytesOf("round-trip-payload"),
    });

    const download = await orgFilesService.openDownload(orgA, file.id);
    expect(download).toBeDefined();
    expect(new TextDecoder().decode(new Uint8Array(download?.body ?? new ArrayBuffer(0)))).toBe(
      "round-trip-payload",
    );

    expect(await orgFilesService.openDownload(orgB, file.id)).toBeUndefined();
  });
});

describe("deleteForOrganization", () => {
  test("deletes an upload's object + row; repeat delete is a clean false", async () => {
    expect(pgliteReady).toBe(true);
    const file = await orgFilesService.uploadFile({
      organizationId: orgA,
      userId: userA,
      filename: "to-delete.txt",
      contentType: "text/plain",
      bytes: bytesOf("bye"),
    });
    expect(objects.has(file.storage_key)).toBe(true);

    expect(await orgFilesService.deleteForOrganization(orgA, file.id)).toBe(true);
    expect(objects.has(file.storage_key)).toBe(false);
    expect(await orgFilesRepository.findByIdForOrganization(file.id, orgA)).toBeUndefined();

    // idempotent second delete: no throw, no partial state
    expect(await orgFilesService.deleteForOrganization(orgA, file.id)).toBe(false);
  });

  test("cross-org delete is refused and removes nothing", async () => {
    expect(pgliteReady).toBe(true);
    const file = await orgFilesService.uploadFile({
      organizationId: orgA,
      userId: userA,
      filename: "keep-me.txt",
      contentType: "text/plain",
      bytes: bytesOf("keep"),
    });
    expect(await orgFilesService.deleteForOrganization(orgB, file.id)).toBe(false);
    expect(objects.has(file.storage_key)).toBe(true);
    expect(await orgFilesRepository.findByIdForOrganization(file.id, orgA)).toBeDefined();
  });

  test("deleting a generation-sourced row keeps the generation's object", async () => {
    expect(pgliteReady).toBe(true);
    const key = `generations/${orgA}/shared-asset.png`;
    objects.set(key, new TextEncoder().encode("shared"));
    const generationId = await seedGeneration({
      organizationId: orgA,
      status: "completed",
      storageUrl: `https://blob.elizacloud.ai/${key}`,
      fileSize: 6n,
    });
    const imported = await orgFilesService.importGeneration({
      organizationId: orgA,
      userId: userA,
      generationId,
    });

    expect(await orgFilesService.deleteForOrganization(orgA, imported.id)).toBe(true);
    // The generation record (and gallery) still reference this object.
    expect(objects.has(key)).toBe(true);
  });
});
