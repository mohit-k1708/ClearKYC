-- CreateTable
CREATE TABLE "KYCRequirement" (
    "id" SERIAL NOT NULL,
    "customer_type_id" INTEGER NOT NULL,
    "risk_level" TEXT NOT NULL,
    "document_type" TEXT NOT NULL,
    "is_mandatory" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KYCRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reviewer" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reviewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" SERIAL NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "requirement_id" INTEGER,
    "document_type" TEXT NOT NULL,
    "document_number" TEXT,
    "document_number_hash" TEXT,
    "issue_date" DATE NOT NULL,
    "expiry_date" DATE,
    "submission_date" DATE NOT NULL,
    "notes" TEXT,
    "file_reference" TEXT,
    "original_file_name" TEXT,
    "file_mime_type" TEXT,
    "file_size_bytes" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" SERIAL NOT NULL,
    "document_id" INTEGER NOT NULL,
    "reviewer_id" INTEGER,
    "status" TEXT NOT NULL,
    "remarks" TEXT,
    "verification_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KYCRequirement_customer_type_id_risk_level_is_active_idx" ON "KYCRequirement"("customer_type_id", "risk_level", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "KYCRequirement_customer_type_id_risk_level_document_type_ef_key" ON "KYCRequirement"("customer_type_id", "risk_level", "document_type", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "Reviewer_email_key" ON "Reviewer"("email");

-- CreateIndex
CREATE INDEX "Document_customer_id_idx" ON "Document"("customer_id");

-- CreateIndex
CREATE INDEX "Document_document_type_idx" ON "Document"("document_type");

-- CreateIndex
CREATE INDEX "Document_status_idx" ON "Document"("status");

-- CreateIndex
CREATE INDEX "Document_expiry_date_idx" ON "Document"("expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "Document_customer_id_document_type_document_number_hash_iss_key" ON "Document"("customer_id", "document_type", "document_number_hash", "issue_date", "submission_date");

-- CreateIndex
CREATE INDEX "Verification_document_id_id_idx" ON "Verification"("document_id", "id");

-- CreateIndex
CREATE INDEX "Verification_reviewer_id_idx" ON "Verification"("reviewer_id");

-- AddForeignKey
ALTER TABLE "KYCRequirement" ADD CONSTRAINT "KYCRequirement_customer_type_id_fkey" FOREIGN KEY ("customer_type_id") REFERENCES "CustomerType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "KYCRequirement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "Reviewer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written additions (Prisma cannot express these)
-- ===========================================================================

-- CHECK constraints ------------------------------------------------------------------
ALTER TABLE "KYCRequirement"
  ADD CONSTRAINT "KYCRequirement_risk_check" CHECK ("risk_level" IN ('Low', 'Medium', 'High')),
  ADD CONSTRAINT "KYCRequirement_doc_type_check" CHECK (length(btrim("document_type")) > 0),
  ADD CONSTRAINT "KYCRequirement_dates_check" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

ALTER TABLE "Reviewer"
  ADD CONSTRAINT "Reviewer_role_check" CHECK ("role" IN ('Analyst', 'Reviewer', 'Admin'));

ALTER TABLE "Document"
  ADD CONSTRAINT "Document_status_check" CHECK ("status" IN ('Pending', 'In Review', 'Verified', 'Rejected', 'Requires Resubmission')),
  ADD CONSTRAINT "Document_doc_type_check" CHECK (length(btrim("document_type")) > 0),
  ADD CONSTRAINT "Document_dates_check" CHECK (
    ("expiry_date" IS NULL OR "expiry_date" >= "issue_date") AND "submission_date" >= "issue_date"
  ),
  -- number and its hash are stored together or not at all
  ADD CONSTRAINT "Document_number_pair_check" CHECK (("document_number" IS NULL) = ("document_number_hash" IS NULL)),
  -- file metadata is all-or-nothing, and the size is sane
  ADD CONSTRAINT "Document_file_meta_check" CHECK (
    ("file_reference" IS NULL AND "original_file_name" IS NULL AND "file_mime_type" IS NULL AND "file_size_bytes" IS NULL)
    OR
    ("file_reference" IS NOT NULL AND "original_file_name" IS NOT NULL AND "file_mime_type" IS NOT NULL
       AND "file_size_bytes" IS NOT NULL AND "file_size_bytes" > 0 AND "file_size_bytes" <= 10485760)
  );

ALTER TABLE "Verification"
  ADD CONSTRAINT "Verification_status_check" CHECK ("status" IN ('Pending', 'In Review', 'Verified', 'Rejected', 'Requires Resubmission')),
  -- a rejection / resubmission request must explain itself
  ADD CONSTRAINT "Verification_remarks_check" CHECK (
    "status" NOT IN ('Rejected', 'Requires Resubmission') OR length(btrim(coalesce("remarks", ''))) > 0
  ),
  -- every human decision is attributed to a reviewer; only the system-made "Pending" row may have none
  ADD CONSTRAINT "Verification_reviewer_check" CHECK ("status" = 'Pending' OR "reviewer_id" IS NOT NULL);

-- Verification history is INSERT-ONLY ---------------------------------------------------
-- Previous decisions can never be edited. DELETE is blocked too, except through an explicit
-- maintenance switch (SET LOCAL app.allow_history_delete = 'on') that only the test-suite cleanup uses.
CREATE FUNCTION verification_block_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Verification records are immutable: record a new verification instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Verification_no_update"
  BEFORE UPDATE ON "Verification"
  FOR EACH ROW EXECUTE FUNCTION verification_block_update();

CREATE FUNCTION verification_block_delete() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.allow_history_delete', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Verification history cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Verification_no_delete"
  BEFORE DELETE ON "Verification"
  FOR EACH ROW EXECUTE FUNCTION verification_block_delete();

-- Only active Reviewers/Admins may record a decision (database-level authorisation) ----------
CREATE FUNCTION verification_check_reviewer() RETURNS trigger AS $$
DECLARE
  r_role TEXT;
  r_active BOOLEAN;
BEGIN
  IF NEW."status" <> 'Pending' THEN
    SELECT "role", "is_active" INTO r_role, r_active FROM "Reviewer" WHERE "id" = NEW."reviewer_id";
    IF r_role IS NULL OR r_active IS NOT TRUE OR r_role NOT IN ('Reviewer', 'Admin') THEN
      RAISE EXCEPTION 'Reviewer % is not authorised to record verification decisions', NEW."reviewer_id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Verification_reviewer_authorised"
  BEFORE INSERT ON "Verification"
  FOR EACH ROW EXECUTE FUNCTION verification_check_reviewer();

-- The newest Verification decides Document.status ----------------------------------------------
CREATE FUNCTION verification_sync_document_status() RETURNS trigger AS $$
BEGIN
  UPDATE "Document" SET "status" = NEW."status", "updated_at" = now() WHERE "id" = NEW."document_id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Verification_sync_status"
  AFTER INSERT ON "Verification"
  FOR EACH ROW EXECUTE FUNCTION verification_sync_document_status();

-- Document guards: the owner never changes, and status can only change via a Verification insert
-- (pg_trigger_depth() is 1 for a direct UPDATE and 2 when fired from the trigger above).
CREATE FUNCTION document_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW."customer_id" IS DISTINCT FROM OLD."customer_id" THEN
    RAISE EXCEPTION 'A document cannot be moved to another customer';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Document status is derived from verification records and cannot be set directly';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Document_guard"
  BEFORE UPDATE ON "Document"
  FOR EACH ROW EXECUTE FUNCTION document_guard_update();
