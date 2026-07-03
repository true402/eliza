/**
 * Managed cloud asset library (#10688 / #11743).
 *
 * Backs `/api/v1/files`: org-scoped upload/list/get/download/delete over the
 * existing R2 blob bucket plus the `org_files` metadata table. Uploads are
 * written under the PRIVATE `org-files/` key prefix — intentionally NOT in
 * `PUBLIC_BLOB_PREFIXES` (cloud/api `blob-host.ts`), so bytes are only
 * reachable through the authenticated download route. Completed generations
 * (already public-by-URL under `generations/`) can be saved into the library
 * by reference; the library row never owns the generation's bytes.
 */

import { randomUUID } from "node:crypto";
import { generationsRepository, orgFilesRepository } from "../../db/repositories";
import type { OrgFile, OrgFileSource } from "../../db/schemas/org-files";
import { ApiError, NotFoundError, ValidationError } from "../api/cloud-worker-errors";
import { isValidBlobUrl } from "../blob";
import { getRuntimeR2Bucket, type RuntimeR2Bucket } from "../storage/r2-runtime-binding";

/** Private R2 key prefix for uploaded library assets. Never public-by-URL. */
export const ORG_FILES_KEY_PREFIX = "org-files";

/** Maximum size per uploaded library asset (25 MB). */
export const ORG_FILES_MAX_FILE_SIZE = 25 * 1024 * 1024;

export type OrgFileKind = "image" | "video" | "audio" | "text" | "application";

export interface OrgFileDto {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  source: OrgFileSource;
  generationId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** Authenticated byte access — same-origin API path, not a public URL. */
  downloadPath: string;
}

export function toOrgFileDto(file: OrgFile): OrgFileDto {
  return {
    id: file.id,
    filename: file.filename,
    contentType: file.content_type,
    sizeBytes: file.size_bytes,
    source: file.source,
    generationId: file.generation_id,
    metadata: file.metadata,
    createdAt: file.created_at.toISOString(),
    updatedAt: file.updated_at.toISOString(),
    downloadPath: `/api/v1/files/${file.id}/download`,
  };
}

/**
 * Strips any path components and unsafe characters from a client-supplied
 * filename; falls back to "file" when nothing safe remains.
 */
export function sanitizeOrgFileFilename(raw: string): string {
  const basename = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = basename.replace(/[^a-zA-Z0-9._ =-]/g, "_").trim();
  const bounded = cleaned.slice(0, 128).replace(/^\.+/, "");
  return bounded.length > 0 ? bounded : "file";
}

function requireBucket(): RuntimeR2Bucket {
  const bucket = getRuntimeR2Bucket();
  if (!bucket) {
    throw new ApiError(503, "internal_error", "File storage is not configured for this runtime");
  }
  return bucket;
}

/** Derives the R2 object key from a generation's trusted public storage URL. */
function storageKeyFromBlobUrl(storageUrl: string): string | null {
  if (!isValidBlobUrl(storageUrl)) return null;
  const key = decodeURIComponent(new URL(storageUrl).pathname).replace(/^\/+/, "");
  return key.length > 0 ? key : null;
}

export class OrgFilesService {
  async uploadFile(params: {
    organizationId: string;
    userId: string;
    filename: string;
    contentType: string;
    bytes: ArrayBuffer;
  }): Promise<OrgFile> {
    if (params.bytes.byteLength === 0) {
      throw ValidationError("Uploaded file is empty");
    }
    if (params.bytes.byteLength > ORG_FILES_MAX_FILE_SIZE) {
      throw ValidationError(
        `File exceeds the ${ORG_FILES_MAX_FILE_SIZE / (1024 * 1024)}MB upload limit`,
      );
    }

    const bucket = requireBucket();
    const id = randomUUID();
    const filename = sanitizeOrgFileFilename(params.filename);
    const storageKey = `${ORG_FILES_KEY_PREFIX}/${params.organizationId}/${id}/${filename}`;

    await bucket.put(storageKey, params.bytes, {
      httpMetadata: { contentType: params.contentType },
    });

    try {
      return await orgFilesRepository.create({
        id,
        organization_id: params.organizationId,
        user_id: params.userId,
        filename,
        content_type: params.contentType,
        size_bytes: params.bytes.byteLength,
        storage_key: storageKey,
        source: "upload",
      });
    } catch (error) {
      // The metadata row is the source of truth; without it the object is an
      // unreachable orphan, so reclaim it before surfacing the failure.
      await bucket.delete(storageKey);
      throw error;
    }
  }

  /**
   * Saves a completed, org-owned generation into the library by reference.
   * Idempotent: re-importing returns the existing row.
   */
  async importGeneration(params: {
    organizationId: string;
    userId: string;
    generationId: string;
  }): Promise<OrgFile> {
    const existing = await orgFilesRepository.findByGenerationIdForOrganization(
      params.generationId,
      params.organizationId,
    );
    if (existing) return existing;

    const generation = await generationsRepository.findById(params.generationId);
    if (!generation || generation.organization_id !== params.organizationId) {
      throw NotFoundError("Generation not found");
    }
    if (generation.status !== "completed" || !generation.storage_url) {
      throw new ApiError(422, "validation_error", "Generation has no stored asset to import");
    }
    const storageKey = storageKeyFromBlobUrl(generation.storage_url);
    if (!storageKey) {
      throw new ApiError(
        422,
        "validation_error",
        "Generation asset is not stored in cloud storage",
      );
    }

    const filename = sanitizeOrgFileFilename(
      storageKey.split("/").pop() || `${generation.type}-${generation.id}`,
    );

    let sizeBytes: number;
    if (generation.file_size != null) {
      sizeBytes = Number(generation.file_size);
    } else {
      // Older generation rows lack file_size — measure the stored object,
      // which also proves it still exists before we reference it.
      const object = await requireBucket().get(storageKey);
      if (!object?.arrayBuffer) {
        throw new ApiError(422, "validation_error", "Generation asset bytes are missing");
      }
      sizeBytes = (await object.arrayBuffer()).byteLength;
    }

    return await orgFilesRepository.create({
      organization_id: params.organizationId,
      user_id: params.userId,
      filename,
      content_type: generation.mime_type ?? "application/octet-stream",
      size_bytes: sizeBytes,
      storage_key: storageKey,
      source: "generation",
      generation_id: generation.id,
    });
  }

  async getForOrganization(organizationId: string, id: string): Promise<OrgFile | undefined> {
    return await orgFilesRepository.findByIdForOrganization(id, organizationId);
  }

  async list(
    organizationId: string,
    options: { kind?: OrgFileKind; source?: OrgFileSource; limit: number; offset: number },
  ): Promise<{ files: OrgFile[]; total: number }> {
    const filter = {
      contentTypePrefix: options.kind,
      source: options.source,
      limit: options.limit,
      offset: options.offset,
    };
    const [files, total] = await Promise.all([
      orgFilesRepository.listByOrganization(organizationId, filter),
      orgFilesRepository.countByOrganization(organizationId, filter),
    ]);
    return { files, total };
  }

  /** Returns the file row plus its bytes, or undefined when not owned/found. */
  async openDownload(
    organizationId: string,
    id: string,
  ): Promise<{ file: OrgFile; body: ArrayBuffer } | undefined> {
    const file = await orgFilesRepository.findByIdForOrganization(id, organizationId);
    if (!file) return undefined;
    const object = await requireBucket().get(file.storage_key);
    if (!object?.arrayBuffer) {
      throw new ApiError(
        503,
        "internal_error",
        "Stored file bytes are unavailable — storage object is missing",
      );
    }
    return { file, body: await object.arrayBuffer() };
  }

  /**
   * Deletes the metadata row; uploaded assets also delete their R2 object.
   * Generation-sourced rows never own the object (the generation record and
   * gallery still reference it), so only the row is removed. Returns false
   * when the file does not exist for this org — a repeated delete is a no-op.
   */
  async deleteForOrganization(organizationId: string, id: string): Promise<boolean> {
    const file = await orgFilesRepository.findByIdForOrganization(id, organizationId);
    if (!file) return false;
    if (file.source === "upload") {
      // Object first: R2 delete of a missing key is a no-op, so a retry after
      // a partial failure converges instead of leaking the object.
      await requireBucket().delete(file.storage_key);
    }
    await orgFilesRepository.deleteByIdForOrganization(id, organizationId);
    return true;
  }
}

export const orgFilesService = new OrgFilesService();
