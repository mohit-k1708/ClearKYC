-- Phase 6: configurable expiry thresholds and stronger onboarding-decision rules. Additive only: one new table, two new constraints
-- on a table that already exists. No existing row is changed.

-- 1. System settings: a versioned, insert-only history. The newest row of a key is the current value, so a change never overwrites
--    the previous one and "who changed it, when and why" is always known.
CREATE TABLE "SystemSetting" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "changed_by_id" INTEGER NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SystemSetting_key_id_idx" ON "SystemSetting"("key", "id");

ALTER TABLE "SystemSetting" ADD CONSTRAINT "SystemSetting_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "Reviewer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SystemSetting" ADD CONSTRAINT "SystemSetting_key_check" CHECK ("key" IN ('expiry_alert_days'));

-- The expiry lead times must be 1 to 8 whole numbers, each above zero, strictly decreasing (so also unique). The application validates
-- the same rules; this keeps a direct database write from storing a configuration the alert engine cannot use.
CREATE FUNCTION valid_expiry_alert_days(v JSONB) RETURNS BOOLEAN AS $$
DECLARE
  n INTEGER;
  i INTEGER;
  prev NUMERIC;
  cur NUMERIC;
BEGIN
  IF jsonb_typeof(v) <> 'array' THEN RETURN FALSE; END IF;
  n := jsonb_array_length(v);
  IF n < 1 OR n > 8 THEN RETURN FALSE; END IF;
  FOR i IN 0 .. n - 1 LOOP
    IF jsonb_typeof(v -> i) <> 'number' THEN RETURN FALSE; END IF;
    cur := (v ->> i)::NUMERIC;
    IF cur <= 0 OR cur <> trunc(cur) OR cur > 3650 THEN RETURN FALSE; END IF;
    IF i > 0 AND cur >= prev THEN RETURN FALSE; END IF;
    prev := cur;
  END LOOP;
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE "SystemSetting" ADD CONSTRAINT "SystemSetting_value_check" CHECK ("key" <> 'expiry_alert_days' OR valid_expiry_alert_days("value"));

CREATE TRIGGER "SystemSetting_no_update" BEFORE UPDATE ON "SystemSetting" FOR EACH ROW EXECUTE FUNCTION history_block_update();
CREATE TRIGGER "SystemSetting_no_delete" BEFORE DELETE ON "SystemSetting" FOR EACH ROW EXECUTE FUNCTION history_block_delete();

-- Only an active Reviewer or Admin may change a setting.
CREATE FUNCTION system_setting_check_reviewer() RETURNS trigger AS $$
DECLARE
  r_role TEXT;
  r_active BOOLEAN;
BEGIN
  SELECT "role", "is_active" INTO r_role, r_active FROM "Reviewer" WHERE "id" = NEW."changed_by_id";
  IF r_role IS NULL OR r_active IS NOT TRUE OR r_role NOT IN ('Reviewer', 'Admin') THEN
    RAISE EXCEPTION 'Reviewer % is not authorised to change settings', NEW."changed_by_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SystemSetting_reviewer_authorised" BEFORE INSERT ON "SystemSetting" FOR EACH ROW EXECUTE FUNCTION system_setting_check_reviewer();

-- 2. Onboarding decisions. A customer has at most ONE final decision (Approved or Rejected): the workflow rule is also a database
--    rule, so two simultaneous requests cannot both succeed. Every Approved / Rejected decision must carry its reason.
CREATE UNIQUE INDEX "OnboardingDecision_one_final_per_customer" ON "OnboardingDecision"("customer_id") WHERE "decision" IN ('Approved', 'Rejected');
ALTER TABLE "OnboardingDecision" ADD CONSTRAINT "OnboardingDecision_reason_check" CHECK ("decision" = 'Pending Review' OR length(btrim(coalesce("notes", ''))) > 0);
