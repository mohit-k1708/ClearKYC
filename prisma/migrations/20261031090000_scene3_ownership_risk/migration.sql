-- Scene 3: Risk Assessment & Beneficial Ownership
-- (Written by hand from the Prisma diff so existing Scene 1 ratings can be back-filled safely.)

-- ===========================================================================
-- 1. Risk assessment IDs: RSK-000001, RSK-000002 ...
--    A sequence is concurrency-safe and never hands out a number twice.
-- ===========================================================================
CREATE SEQUENCE "risk_assessment_seq" START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE FUNCTION next_risk_assessment_code() RETURNS TEXT AS $$
  SELECT 'RSK-' || lpad(nextval('risk_assessment_seq')::text, 6, '0');
$$ LANGUAGE sql;

-- ===========================================================================
-- 2. Extend RiskRating (Scene 1 inserts keep working: every new column has a default or is nullable)
-- ===========================================================================
ALTER TABLE "RiskRating"
  ADD COLUMN "assessed_by_id" INTEGER,
  ADD COLUMN "assessment_status" TEXT NOT NULL DEFAULT 'Completed',
  ADD COLUMN "previous_risk_level" TEXT,
  ADD COLUMN "assessment_code" TEXT;

-- Existing ratings get codes in creation order, then the column becomes mandatory with a database default.
UPDATE "RiskRating" r
   SET "assessment_code" = 'RSK-' || lpad(n.rn::text, 6, '0')
  FROM (SELECT "id", row_number() OVER (ORDER BY "id") AS rn FROM "RiskRating") n
 WHERE n."id" = r."id";

SELECT setval('risk_assessment_seq', (SELECT count(*) FROM "RiskRating") + 1, false);

ALTER TABLE "RiskRating"
  ALTER COLUMN "assessment_code" SET NOT NULL,
  ALTER COLUMN "assessment_code" SET DEFAULT next_risk_assessment_code();

-- ===========================================================================
-- 3. New tables
-- ===========================================================================
CREATE TABLE "BeneficialOwner" (
    "id" SERIAL NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "full_name" TEXT NOT NULL,
    "date_of_birth" TEXT,
    "country_of_residence" TEXT,
    "nationality" TEXT,
    "ownership_percentage" DECIMAL(5,2),
    "ownership_type" TEXT NOT NULL,
    "control_type" TEXT NOT NULL,
    "pep_status" TEXT NOT NULL DEFAULT 'Unknown',
    "notes" TEXT,
    "identity_hash" TEXT,
    "created_by_id" INTEGER,
    "updated_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BeneficialOwner_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OwnerScreening" (
    "id" SERIAL NOT NULL,
    "beneficial_owner_id" INTEGER NOT NULL,
    "screening_type" TEXT NOT NULL,
    "screening_result" TEXT NOT NULL,
    "risk_points" INTEGER NOT NULL,
    "remarks" TEXT,
    "source" TEXT NOT NULL,
    "screened_by_id" INTEGER,
    "screened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerScreening_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OwnershipValidation" (
    "id" SERIAL NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "total_ownership_percentage" DECIMAL(7,2) NOT NULL,
    "owner_count" INTEGER NOT NULL,
    "validation_status" TEXT NOT NULL,
    "validation_message" TEXT NOT NULL,
    "checked_by_id" INTEGER,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnershipValidation_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "BeneficialOwner_customer_id_idx" ON "BeneficialOwner"("customer_id");
CREATE INDEX "BeneficialOwner_full_name_idx" ON "BeneficialOwner"("full_name");
CREATE UNIQUE INDEX "BeneficialOwner_customer_id_identity_hash_key" ON "BeneficialOwner"("customer_id", "identity_hash");
CREATE INDEX "OwnerScreening_beneficial_owner_id_screening_type_id_idx" ON "OwnerScreening"("beneficial_owner_id", "screening_type", "id");
CREATE INDEX "OwnershipValidation_customer_id_id_idx" ON "OwnershipValidation"("customer_id", "id");
CREATE UNIQUE INDEX "RiskRating_assessment_code_key" ON "RiskRating"("assessment_code");
CREATE INDEX "RiskRating_assessment_status_idx" ON "RiskRating"("assessment_status");

-- Foreign keys
ALTER TABLE "RiskRating" ADD CONSTRAINT "RiskRating_assessed_by_id_fkey" FOREIGN KEY ("assessed_by_id") REFERENCES "Reviewer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BeneficialOwner" ADD CONSTRAINT "BeneficialOwner_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BeneficialOwner" ADD CONSTRAINT "BeneficialOwner_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "Reviewer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BeneficialOwner" ADD CONSTRAINT "BeneficialOwner_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "Reviewer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OwnerScreening" ADD CONSTRAINT "OwnerScreening_beneficial_owner_id_fkey" FOREIGN KEY ("beneficial_owner_id") REFERENCES "BeneficialOwner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OwnerScreening" ADD CONSTRAINT "OwnerScreening_screened_by_id_fkey" FOREIGN KEY ("screened_by_id") REFERENCES "Reviewer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OwnershipValidation" ADD CONSTRAINT "OwnershipValidation_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OwnershipValidation" ADD CONSTRAINT "OwnershipValidation_checked_by_id_fkey" FOREIGN KEY ("checked_by_id") REFERENCES "Reviewer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- 4. CHECK constraints
-- ===========================================================================
ALTER TABLE "RiskRating"
  ADD CONSTRAINT "RiskRating_previous_level_check" CHECK ("previous_risk_level" IS NULL OR "previous_risk_level" IN ('Low', 'Medium', 'High')),
  ADD CONSTRAINT "RiskRating_status_check" CHECK ("assessment_status" IN ('Completed', 'Requires Manual Review')),
  ADD CONSTRAINT "RiskRating_code_format_check" CHECK ("assessment_code" ~ '^RSK-[0-9]{6,}$');

ALTER TABLE "BeneficialOwner"
  ADD CONSTRAINT "BeneficialOwner_name_check" CHECK (length(btrim("full_name")) > 0),
  ADD CONSTRAINT "BeneficialOwner_percentage_check" CHECK ("ownership_percentage" IS NULL OR ("ownership_percentage" > 0 AND "ownership_percentage" <= 100)),
  ADD CONSTRAINT "BeneficialOwner_ownership_type_check" CHECK ("ownership_type" IN ('Direct', 'Indirect')),
  ADD CONSTRAINT "BeneficialOwner_pep_status_check" CHECK ("pep_status" IN ('Yes', 'No', 'Unknown')),
  ADD CONSTRAINT "BeneficialOwner_control_type_check" CHECK (length(btrim("control_type")) > 0),
  ADD CONSTRAINT "BeneficialOwner_country_check" CHECK (
    ("country_of_residence" IS NULL OR "country_of_residence" ~ '^[A-Z]{2}$') AND ("nationality" IS NULL OR "nationality" ~ '^[A-Z]{2}$')
  );

ALTER TABLE "OwnerScreening"
  ADD CONSTRAINT "OwnerScreening_type_check" CHECK ("screening_type" IN ('PEP', 'Sanctions')),
  ADD CONSTRAINT "OwnerScreening_result_check" CHECK ("screening_result" IN ('Confirmed', 'Potential Match', 'No Match')),
  ADD CONSTRAINT "OwnerScreening_points_check" CHECK ("risk_points" >= 0),
  ADD CONSTRAINT "OwnerScreening_source_check" CHECK ("source" IN ('Simulated list match', 'Manual entry (synthetic)')),
  -- a match (or confirmation) has to be explained
  ADD CONSTRAINT "OwnerScreening_remarks_check" CHECK ("screening_result" = 'No Match' OR length(btrim(coalesce("remarks", ''))) > 0);

ALTER TABLE "OwnershipValidation"
  ADD CONSTRAINT "OwnershipValidation_status_check" CHECK ("validation_status" IN ('RECONCILED', 'EXCEEDS_100', 'BELOW_100', 'NO_OWNERS', 'MISSING_PERCENTAGE')),
  ADD CONSTRAINT "OwnershipValidation_total_check" CHECK ("total_ownership_percentage" >= 0 AND "owner_count" >= 0);

-- ===========================================================================
-- 5. Triggers
-- ===========================================================================

-- Beneficial owners belong to COMPANY customers only (customer type 2), and never move to another company.
CREATE FUNCTION beneficial_owner_company_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."customer_id" IS DISTINCT FROM OLD."customer_id" THEN
    RAISE EXCEPTION 'A beneficial owner cannot be moved to another customer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Customer" WHERE "id" = NEW."customer_id" AND "customer_type_id" = 2) THEN
    RAISE EXCEPTION 'Beneficial owners can only be recorded for company customers';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BeneficialOwner_company_only"
  BEFORE INSERT OR UPDATE ON "BeneficialOwner"
  FOR EACH ROW EXECUTE FUNCTION beneficial_owner_company_only();

-- History tables are INSERT-ONLY: assessments, screenings and ownership checks are never overwritten.
-- Direct DELETE is refused too. It is allowed only when it is the automatic cascade from deleting the
-- whole customer (pg_trigger_depth() >= 2), or behind the explicit maintenance switch used by test cleanup.
CREATE FUNCTION history_block_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% records are immutable: record a new one instead', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION history_block_delete() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() < 2 AND coalesce(current_setting('app.allow_history_delete', true), '') <> 'on' THEN
    RAISE EXCEPTION '% history cannot be deleted', TG_TABLE_NAME;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RiskRating_no_update" BEFORE UPDATE ON "RiskRating" FOR EACH ROW EXECUTE FUNCTION history_block_update();
CREATE TRIGGER "RiskRating_no_delete" BEFORE DELETE ON "RiskRating" FOR EACH ROW EXECUTE FUNCTION history_block_delete();
CREATE TRIGGER "OwnerScreening_no_update" BEFORE UPDATE ON "OwnerScreening" FOR EACH ROW EXECUTE FUNCTION history_block_update();
CREATE TRIGGER "OwnerScreening_no_delete" BEFORE DELETE ON "OwnerScreening" FOR EACH ROW EXECUTE FUNCTION history_block_delete();
CREATE TRIGGER "OwnershipValidation_no_update" BEFORE UPDATE ON "OwnershipValidation" FOR EACH ROW EXECUTE FUNCTION history_block_update();
CREATE TRIGGER "OwnershipValidation_no_delete" BEFORE DELETE ON "OwnershipValidation" FOR EACH ROW EXECUTE FUNCTION history_block_delete();
