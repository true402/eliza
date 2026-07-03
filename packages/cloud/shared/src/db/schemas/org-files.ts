import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { generations } from "./generations";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * Org files table schema — the managed cloud asset library (#10688 / #11743).
 *
 * One row per library asset. Uploaded assets own a private R2 object under
 * `org-files/<orgId>/…` (never a public-by-URL prefix — see
 * `PUBLIC_BLOB_PREFIXES` in cloud/api `blob-host.ts`); generation-sourced rows
 * reference the generation's existing R2 object and never own its bytes.
 */
export const orgFiles = pgTable(
  "org_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    filename: text("filename").notNull(),
    content_type: text("content_type").notNull(),
    size_bytes: bigint("size_bytes", { mode: "number" }).notNull(),
    /** R2 object key. Owned by this row only when `source` is "upload". */
    storage_key: text("storage_key").notNull(),
    source: text("source", { enum: ["upload", "generation"] })
      .notNull()
      .default("upload"),
    generation_id: uuid("generation_id").references(() => generations.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    organization_idx: index("org_files_organization_idx").on(table.organization_id),
    org_created_idx: index("org_files_org_created_idx").on(table.organization_id, table.created_at),
    generation_idx: index("org_files_generation_idx").on(table.generation_id),
    // A completed generation can be saved to the library at most once, which
    // makes the import endpoint idempotent.
    generation_unique_idx: uniqueIndex("org_files_generation_unique_idx")
      .on(table.generation_id)
      .where(sql`${table.generation_id} IS NOT NULL`),
  }),
);

export type OrgFile = InferSelectModel<typeof orgFiles>;
export type NewOrgFile = InferInsertModel<typeof orgFiles>;
export type OrgFileSource = OrgFile["source"];
