-- Prisma writes timestamps in UTC. The status-sync trigger used now() (database local time),
-- which made Document.updated_at disagree with created_at. Write UTC here too.
CREATE OR REPLACE FUNCTION verification_sync_document_status() RETURNS trigger AS $$
BEGIN
  UPDATE "Document"
     SET "status" = NEW."status", "updated_at" = (now() AT TIME ZONE 'UTC')
   WHERE "id" = NEW."document_id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
