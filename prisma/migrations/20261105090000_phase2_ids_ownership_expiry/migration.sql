-- Phase 2: required business ID formats, per-threshold expiry alerts and the CompanyOwnership bridge.
-- ADDITIVE ONLY: no table is dropped or recreated, no column is removed, no existing value is changed
-- (existing rows only receive values in NEW columns, deterministically ordered by their numeric id).

-- ===========================================================================
-- 1. Scoped counters (gap-free, concurrency safe): the row lock serialises callers, and a rolled-back
--    transaction undoes its increment.
-- ===========================================================================
CREATE TABLE "IdCounter" (
    "scope" TEXT NOT NULL,
    "period" INTEGER NOT NULL DEFAULT 0,
    "last_value" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "IdCounter_pkey" PRIMARY KEY ("scope", "period"),
    CONSTRAINT "IdCounter_value_check" CHECK ("last_value" >= 0)
);

CREATE FUNCTION next_scoped_number(p_scope TEXT, p_period INTEGER) RETURNS INTEGER AS $$
  INSERT INTO "IdCounter" ("scope", "period", "last_value") VALUES (p_scope, p_period, 1)
  ON CONFLICT ("scope", "period") DO UPDATE SET "last_value" = "IdCounter"."last_value" + 1
  RETURNING "last_value";
$$ LANGUAGE sql;

-- ===========================================================================
-- 2. New business ID columns (nullable first, so existing rows can be backfilled)
-- ===========================================================================
ALTER TABLE "KYCRequirement" ADD COLUMN "business_id" TEXT;   -- KYC-2026-000001
ALTER TABLE "Document"       ADD COLUMN "business_id" TEXT;   -- DOC-CUS-000001-001
ALTER TABLE "ReviewCase"     ADD COLUMN "review_code" TEXT;   -- REV-CUS-000001-2026 (-02, -03 for a customer's later cases in the same year)
ALTER TABLE "Alert"          ADD COLUMN "business_id" TEXT;   -- ALT-2026-000001
ALTER TABLE "Alert"          ADD COLUMN "threshold" INTEGER;  -- expiry lead time (90, 60, 30, 7) for expiry alerts

-- ===========================================================================
-- 3. Triggers that fill the code when the application does not supply one
-- ===========================================================================
CREATE FUNCTION fill_requirement_business_id() RETURNS trigger AS $$
DECLARE y INTEGER;
BEGIN
  IF NEW."business_id" IS NULL THEN
    y := EXTRACT(YEAR FROM NEW."effective_from")::INTEGER;
    NEW."business_id" := 'KYC-' || y || '-' || lpad(next_scoped_number('KYC', y)::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION fill_document_business_id() RETURNS trigger AS $$
DECLARE code TEXT;
BEGIN
  IF NEW."business_id" IS NULL THEN
    SELECT "customer_id" INTO code FROM "Customer" WHERE "id" = NEW."customer_id";
    NEW."business_id" := 'DOC-' || code || '-' || lpad(next_scoped_number('DOC:' || code, 0)::text, 3, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION fill_alert_business_id() RETURNS trigger AS $$
DECLARE y INTEGER;
BEGIN
  IF NEW."business_id" IS NULL THEN
    y := EXTRACT(YEAR FROM NEW."created_at")::INTEGER;
    NEW."business_id" := 'ALT-' || y || '-' || lpad(next_scoped_number('ALT', y)::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION fill_review_code() RETURNS trigger AS $$
DECLARE code TEXT; y INTEGER; n INTEGER;
BEGIN
  IF NEW."review_code" IS NULL THEN
    SELECT "customer_id" INTO code FROM "Customer" WHERE "id" = NEW."customer_id";
    y := EXTRACT(YEAR FROM NEW."created_at")::INTEGER;
    n := next_scoped_number('REV:' || code, y);
    NEW."review_code" := 'REV-' || code || '-' || y || CASE WHEN n > 1 THEN '-' || lpad(n::text, 2, '0') ELSE '' END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "KYCRequirement_fill_code" BEFORE INSERT ON "KYCRequirement" FOR EACH ROW EXECUTE FUNCTION fill_requirement_business_id();
CREATE TRIGGER "Document_fill_code" BEFORE INSERT ON "Document" FOR EACH ROW EXECUTE FUNCTION fill_document_business_id();
CREATE TRIGGER "Alert_fill_code" BEFORE INSERT ON "Alert" FOR EACH ROW EXECUTE FUNCTION fill_alert_business_id();
CREATE TRIGGER "ReviewCase_fill_code" BEFORE INSERT ON "ReviewCase" FOR EACH ROW EXECUTE FUNCTION fill_review_code();

-- ===========================================================================
-- 4. Deterministic backfill of EXISTING rows (ordered by the numeric id) and the matching counters
-- ===========================================================================
UPDATE "KYCRequirement" r SET "business_id" = 'KYC-' || x.y || '-' || lpad(x.n::text, 6, '0')
FROM (SELECT "id", EXTRACT(YEAR FROM "effective_from")::INTEGER AS y, row_number() OVER (PARTITION BY EXTRACT(YEAR FROM "effective_from") ORDER BY "id") AS n FROM "KYCRequirement") x
WHERE r."id" = x."id" AND r."business_id" IS NULL;

UPDATE "Document" d SET "business_id" = 'DOC-' || x.code || '-' || lpad(x.n::text, 3, '0')
FROM (SELECT d2."id", c."customer_id" AS code, row_number() OVER (PARTITION BY d2."customer_id" ORDER BY d2."id") AS n FROM "Document" d2 JOIN "Customer" c ON c."id" = d2."customer_id") x
WHERE d."id" = x."id" AND d."business_id" IS NULL;

UPDATE "Alert" a SET "business_id" = 'ALT-' || x.y || '-' || lpad(x.n::text, 6, '0')
FROM (SELECT "id", EXTRACT(YEAR FROM "created_at")::INTEGER AS y, row_number() OVER (PARTITION BY EXTRACT(YEAR FROM "created_at") ORDER BY "id") AS n FROM "Alert") x
WHERE a."id" = x."id" AND a."business_id" IS NULL;

UPDATE "ReviewCase" rc SET "review_code" = 'REV-' || x.code || '-' || x.y || CASE WHEN x.n > 1 THEN '-' || lpad(x.n::text, 2, '0') ELSE '' END
FROM (SELECT c2."id", cu."customer_id" AS code, EXTRACT(YEAR FROM c2."created_at")::INTEGER AS y, row_number() OVER (PARTITION BY c2."customer_id", EXTRACT(YEAR FROM c2."created_at") ORDER BY c2."id") AS n FROM "ReviewCase" c2 JOIN "Customer" cu ON cu."id" = c2."customer_id") x
WHERE rc."id" = x."id" AND rc."review_code" IS NULL;

INSERT INTO "IdCounter" ("scope", "period", "last_value")
  SELECT 'KYC', EXTRACT(YEAR FROM "effective_from")::INTEGER, count(*) FROM "KYCRequirement" GROUP BY 1, 2
  ON CONFLICT ("scope", "period") DO UPDATE SET "last_value" = GREATEST("IdCounter"."last_value", EXCLUDED."last_value");
INSERT INTO "IdCounter" ("scope", "period", "last_value")
  SELECT 'ALT', EXTRACT(YEAR FROM "created_at")::INTEGER, count(*) FROM "Alert" GROUP BY 1, 2
  ON CONFLICT ("scope", "period") DO UPDATE SET "last_value" = GREATEST("IdCounter"."last_value", EXCLUDED."last_value");
INSERT INTO "IdCounter" ("scope", "period", "last_value")
  SELECT 'DOC:' || c."customer_id", 0, count(*) FROM "Document" d JOIN "Customer" c ON c."id" = d."customer_id" GROUP BY 1, 2
  ON CONFLICT ("scope", "period") DO UPDATE SET "last_value" = GREATEST("IdCounter"."last_value", EXCLUDED."last_value");
INSERT INTO "IdCounter" ("scope", "period", "last_value")
  SELECT 'REV:' || c."customer_id", EXTRACT(YEAR FROM rc."created_at")::INTEGER, count(*) FROM "ReviewCase" rc JOIN "Customer" c ON c."id" = rc."customer_id" GROUP BY 1, 2
  ON CONFLICT ("scope", "period") DO UPDATE SET "last_value" = GREATEST("IdCounter"."last_value", EXCLUDED."last_value");

-- ===========================================================================
-- 5. Make the codes strict: required, unique, well formed and immutable
-- ===========================================================================
ALTER TABLE "KYCRequirement" ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "Document" ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "ReviewCase" ALTER COLUMN "review_code" SET NOT NULL;
ALTER TABLE "Alert" ALTER COLUMN "business_id" SET NOT NULL;

CREATE UNIQUE INDEX "KYCRequirement_business_id_key" ON "KYCRequirement"("business_id");
CREATE UNIQUE INDEX "Document_business_id_key" ON "Document"("business_id");
CREATE UNIQUE INDEX "ReviewCase_review_code_key" ON "ReviewCase"("review_code");
CREATE UNIQUE INDEX "Alert_business_id_key" ON "Alert"("business_id");

ALTER TABLE "KYCRequirement" ADD CONSTRAINT "KYCRequirement_business_id_check" CHECK ("business_id" ~ '^KYC-[0-9]{4}-[0-9]{6,}$');
ALTER TABLE "Document" ADD CONSTRAINT "Document_business_id_check" CHECK ("business_id" ~ '^DOC-CUS-[0-9]{6,}-[0-9]{3,}$');
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_review_code_check" CHECK ("review_code" ~ '^REV-CUS-[0-9]{6,}-[0-9]{4}(-[0-9]{2,})?$');
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_business_id_check" CHECK ("business_id" ~ '^ALT-[0-9]{4}-[0-9]{6,}$');
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_threshold_check" CHECK ("threshold" IS NULL OR "threshold" > 0);

-- A business code never changes once it has a value.
CREATE FUNCTION forbid_code_change() RETURNS trigger AS $$
BEGIN
  IF to_jsonb(OLD) ->> TG_ARGV[0] IS NOT NULL AND to_jsonb(NEW) ->> TG_ARGV[0] IS DISTINCT FROM to_jsonb(OLD) ->> TG_ARGV[0] THEN
    RAISE EXCEPTION '% is a business ID and cannot be changed', TG_ARGV[0];
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "KYCRequirement_code_immutable" BEFORE UPDATE ON "KYCRequirement" FOR EACH ROW EXECUTE FUNCTION forbid_code_change('business_id');
CREATE TRIGGER "Document_code_immutable" BEFORE UPDATE ON "Document" FOR EACH ROW EXECUTE FUNCTION forbid_code_change('business_id');
CREATE TRIGGER "ReviewCase_review_code_immutable" BEFORE UPDATE ON "ReviewCase" FOR EACH ROW EXECUTE FUNCTION forbid_code_change('review_code');
CREATE TRIGGER "Alert_business_id_immutable" BEFORE UPDATE ON "Alert" FOR EACH ROW EXECUTE FUNCTION forbid_code_change('business_id');

-- ===========================================================================
-- 6. CompanyOwnership: the company-owner relationship with its own percentage and effective dates.
--    It mirrors BeneficialOwner automatically (triggers below), so the application keeps working unchanged
--    and the bridge can never disagree with the owner rows. person_ref groups the rows of the same real person.
-- ===========================================================================
CREATE TABLE "CompanyOwnership" (
    "id" SERIAL NOT NULL,
    "company_customer_id" INTEGER NOT NULL,
    "beneficial_owner_id" INTEGER NOT NULL,
    "person_ref" TEXT NOT NULL,
    "ownership_percentage" DECIMAL(5,2),
    "ownership_type" TEXT NOT NULL,
    "control_type" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompanyOwnership_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CompanyOwnership_pct_check" CHECK ("ownership_percentage" IS NULL OR ("ownership_percentage" > 0 AND "ownership_percentage" <= 100)),
    CONSTRAINT "CompanyOwnership_dates_check" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
    CONSTRAINT "CompanyOwnership_type_check" CHECK ("ownership_type" IN ('Direct', 'Indirect')),
    CONSTRAINT "CompanyOwnership_company_fkey" FOREIGN KEY ("company_customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CompanyOwnership_owner_fkey" FOREIGN KEY ("beneficial_owner_id") REFERENCES "BeneficialOwner"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CompanyOwnership_one_active_per_pair" ON "CompanyOwnership"("company_customer_id", "beneficial_owner_id") WHERE "effective_to" IS NULL;
CREATE INDEX "CompanyOwnership_company_idx" ON "CompanyOwnership"("company_customer_id", "effective_to");
CREATE INDEX "CompanyOwnership_owner_idx" ON "CompanyOwnership"("beneficial_owner_id");
CREATE INDEX "CompanyOwnership_person_idx" ON "CompanyOwnership"("person_ref");

CREATE FUNCTION person_ref_for(p_hash TEXT, p_id INTEGER) RETURNS TEXT AS $$
  SELECT CASE WHEN p_hash IS NOT NULL THEN 'PER-' || substr(p_hash, 1, 12) ELSE 'OWN-' || lpad(p_id::text, 6, '0') END;
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION company_ownership_mirror() RETURNS trigger AS $$
DECLARE today DATE := (now() AT TIME ZONE 'UTC')::date; cur RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "CompanyOwnership" ("company_customer_id", "beneficial_owner_id", "person_ref", "ownership_percentage", "ownership_type", "control_type", "effective_from", "created_at", "updated_at")
    VALUES (NEW."customer_id", NEW."id", person_ref_for(NEW."identity_hash", NEW."id"), NEW."ownership_percentage", NEW."ownership_type", NEW."control_type", NEW."created_at"::date, NEW."created_at", NEW."created_at");
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW."ownership_percentage" IS DISTINCT FROM OLD."ownership_percentage" OR NEW."ownership_type" IS DISTINCT FROM OLD."ownership_type" OR NEW."control_type" IS DISTINCT FROM OLD."control_type" THEN
      SELECT * INTO cur FROM "CompanyOwnership" WHERE "beneficial_owner_id" = NEW."id" AND "effective_to" IS NULL;
      IF FOUND AND cur."effective_from" < today THEN
        -- a change on a later day: close the old relationship and open a new one (history is kept)
        UPDATE "CompanyOwnership" SET "effective_to" = today, "updated_at" = now() WHERE "id" = cur."id";
        INSERT INTO "CompanyOwnership" ("company_customer_id", "beneficial_owner_id", "person_ref", "ownership_percentage", "ownership_type", "control_type", "effective_from")
        VALUES (NEW."customer_id", NEW."id", person_ref_for(NEW."identity_hash", NEW."id"), NEW."ownership_percentage", NEW."ownership_type", NEW."control_type", today);
      ELSIF FOUND THEN
        -- changed again on the day it started: correct the same row
        UPDATE "CompanyOwnership" SET "ownership_percentage" = NEW."ownership_percentage", "ownership_type" = NEW."ownership_type", "control_type" = NEW."control_type", "updated_at" = now() WHERE "id" = cur."id";
      END IF;
    END IF;
    IF NEW."identity_hash" IS DISTINCT FROM OLD."identity_hash" THEN
      UPDATE "CompanyOwnership" SET "person_ref" = person_ref_for(NEW."identity_hash", NEW."id") WHERE "beneficial_owner_id" = NEW."id";
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BeneficialOwner_mirror_insert" AFTER INSERT ON "BeneficialOwner" FOR EACH ROW EXECUTE FUNCTION company_ownership_mirror();
CREATE TRIGGER "BeneficialOwner_mirror_update" AFTER UPDATE ON "BeneficialOwner" FOR EACH ROW EXECUTE FUNCTION company_ownership_mirror();

-- backfill: one relationship row per existing owner row
INSERT INTO "CompanyOwnership" ("company_customer_id", "beneficial_owner_id", "person_ref", "ownership_percentage", "ownership_type", "control_type", "effective_from", "created_at", "updated_at")
  SELECT "customer_id", "id", person_ref_for("identity_hash", "id"), "ownership_percentage", "ownership_type", "control_type", "created_at"::date, "created_at", "updated_at"
  FROM "BeneficialOwner" ORDER BY "id";
