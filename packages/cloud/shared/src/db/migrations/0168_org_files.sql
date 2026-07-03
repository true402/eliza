CREATE TABLE IF NOT EXISTS "org_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid,
  "filename" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "storage_key" text NOT NULL,
  "source" text DEFAULT 'upload' NOT NULL,
  "generation_id" uuid,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "org_files_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade,
  CONSTRAINT "org_files_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null,
  CONSTRAINT "org_files_generation_id_generations_id_fk"
    FOREIGN KEY ("generation_id") REFERENCES "generations"("id") ON DELETE set null
);

CREATE INDEX IF NOT EXISTS "org_files_organization_idx"
  ON "org_files" ("organization_id");
CREATE INDEX IF NOT EXISTS "org_files_org_created_idx"
  ON "org_files" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "org_files_generation_idx"
  ON "org_files" ("generation_id");
CREATE UNIQUE INDEX IF NOT EXISTS "org_files_generation_unique_idx"
  ON "org_files" ("generation_id") WHERE "generation_id" IS NOT NULL;
