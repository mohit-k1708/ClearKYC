-- ROLLBACK for migration 20261107090000_phase6_settings_and_decisions. Prisma does not run this file: it is the documented, tested way
-- to undo the migration by hand (psql -f, or the node snippet in docs/phase6-features.md). It removes only what the migration added.
-- Rows of SystemSetting (the history of changed settings) are lost by DROP TABLE: export them first if they matter.
-- History tables are insert-only, so the maintenance switch is needed to drop the rows' protection triggers' effect (DROP TABLE is allowed).

ALTER TABLE "OnboardingDecision" DROP CONSTRAINT IF EXISTS "OnboardingDecision_reason_check";
DROP INDEX IF EXISTS "OnboardingDecision_one_final_per_customer";

DROP TABLE IF EXISTS "SystemSetting";
DROP FUNCTION IF EXISTS system_setting_check_reviewer();
DROP FUNCTION IF EXISTS valid_expiry_alert_days(JSONB);

-- Then tell Prisma the migration is no longer applied:
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261107090000_phase6_settings_and_decisions';
