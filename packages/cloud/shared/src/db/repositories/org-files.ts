import { and, count, desc, eq, like, type SQL } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import { type NewOrgFile, type OrgFile, type OrgFileSource, orgFiles } from "../schemas/org-files";

export type { NewOrgFile, OrgFile, OrgFileSource };

export interface OrgFileListFilter {
  /** Match `content_type` by top-level MIME family, e.g. "image" → `image/%`. */
  contentTypePrefix?: string;
  source?: OrgFileSource;
  limit: number;
  offset: number;
}

function listPredicates(
  organizationId: string,
  filter: Pick<OrgFileListFilter, "contentTypePrefix" | "source">,
): SQL[] {
  const predicates: SQL[] = [eq(orgFiles.organization_id, organizationId)];
  if (filter.contentTypePrefix) {
    predicates.push(like(orgFiles.content_type, `${filter.contentTypePrefix}/%`));
  }
  if (filter.source) {
    predicates.push(eq(orgFiles.source, filter.source));
  }
  return predicates;
}

export class OrgFilesRepository {
  async create(data: NewOrgFile): Promise<OrgFile> {
    const [row] = await dbWrite.insert(orgFiles).values(data).returning();
    return row;
  }

  async findByIdForOrganization(id: string, organizationId: string): Promise<OrgFile | undefined> {
    const [row] = await dbRead
      .select()
      .from(orgFiles)
      .where(and(eq(orgFiles.id, id), eq(orgFiles.organization_id, organizationId)))
      .limit(1);
    return row;
  }

  async findByGenerationIdForOrganization(
    generationId: string,
    organizationId: string,
  ): Promise<OrgFile | undefined> {
    const [row] = await dbRead
      .select()
      .from(orgFiles)
      .where(
        and(eq(orgFiles.generation_id, generationId), eq(orgFiles.organization_id, organizationId)),
      )
      .limit(1);
    return row;
  }

  async listByOrganization(organizationId: string, filter: OrgFileListFilter): Promise<OrgFile[]> {
    return await dbRead
      .select()
      .from(orgFiles)
      .where(and(...listPredicates(organizationId, filter)))
      .orderBy(desc(orgFiles.created_at), desc(orgFiles.id))
      .limit(filter.limit)
      .offset(filter.offset);
  }

  async countByOrganization(
    organizationId: string,
    filter: Pick<OrgFileListFilter, "contentTypePrefix" | "source">,
  ): Promise<number> {
    const [row] = await dbRead
      .select({ value: count() })
      .from(orgFiles)
      .where(and(...listPredicates(organizationId, filter)));
    return row?.value ?? 0;
  }

  async deleteByIdForOrganization(
    id: string,
    organizationId: string,
  ): Promise<OrgFile | undefined> {
    const [row] = await dbWrite
      .delete(orgFiles)
      .where(and(eq(orgFiles.id, id), eq(orgFiles.organization_id, organizationId)))
      .returning();
    return row;
  }
}

export const orgFilesRepository = new OrgFilesRepository();
