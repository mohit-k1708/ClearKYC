-- Phase 3: support for the edge-case and detection work. Additive only: one nullable column and one new insert-only table.
-- No existing row is changed.

-- 1. The (synthetic) name that appears ON a submitted document, so it can be compared with the customer's registered name.
--    Empty = not captured, which is how every document created before this migration stays.
ALTER TABLE "Document" ADD COLUMN "name_on_document" TEXT;
ALTER TABLE "Document" ADD CONSTRAINT "Document_name_on_document_check" CHECK ("name_on_document" IS NULL OR length(btrim("name_on_document")) > 0);

-- 2. Onboarding decisions: whether a customer was approved. Insert-only history (the newest row is the current decision),
--    so "approved with missing evidence" can be audited against the documents that existed AT THE TIME of the decision.
CREATE TABLE "OnboardingDecision" (
    "id" SERIAL NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "decision" TEXT NOT NULL,
    "decided_by_id" INTEGER NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnboardingDecision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OnboardingDecision_customer_id_decided_at_idx" ON "OnboardingDecision"("customer_id", "decided_at");

ALTER TABLE "OnboardingDecision" ADD CONSTRAINT "OnboardingDecision_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OnboardingDecision" ADD CONSTRAINT "OnboardingDecision_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "Reviewer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OnboardingDecision" ADD CONSTRAINT "OnboardingDecision_decision_check" CHECK ("decision" IN ('Approved', 'Rejected', 'Pending Review'));

-- History is insert-only (same rule as risk ratings and verifications).
CREATE TRIGGER "OnboardingDecision_no_update" BEFORE UPDATE ON "OnboardingDecision" FOR EACH ROW EXECUTE FUNCTION history_block_update();
CREATE TRIGGER "OnboardingDecision_no_delete" BEFORE DELETE ON "OnboardingDecision" FOR EACH ROW EXECUTE FUNCTION history_block_delete();

-- Only an active Reviewer or Admin may approve or reject (a "Pending Review" note may come from anyone).
CREATE FUNCTION onboarding_decision_check_reviewer() RETURNS trigger AS $$
DECLARE
  r_role TEXT;
  r_active BOOLEAN;
BEGIN
  IF NEW."decision" <> 'Pending Review' THEN
    SELECT "role", "is_active" INTO r_role, r_active FROM "Reviewer" WHERE "id" = NEW."decided_by_id";
    IF r_role IS NULL OR r_active IS NOT TRUE OR r_role NOT IN ('Reviewer', 'Admin') THEN
      RAISE EXCEPTION 'Reviewer % is not authorised to approve or reject a customer', NEW."decided_by_id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OnboardingDecision_reviewer_authorised" BEFORE INSERT ON "OnboardingDecision" FOR EACH ROW EXECUTE FUNCTION onboarding_decision_check_reviewer();
