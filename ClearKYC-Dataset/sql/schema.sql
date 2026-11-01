-- ClearKYC database schema (PostgreSQL 17), generated from the live catalogue of the dataset database.
-- Load order: sequences, functions, tables, keys and checks, indexes, foreign keys, triggers.
-- Then load seed.sql, which disables the triggers while it inserts and enables them again afterwards.

SET check_function_bodies = off; -- a function may mention a table that is created further down
SET standard_conforming_strings = on;

-- Sequences
CREATE SEQUENCE "Alert_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "AuditEvent_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "BeneficialOwner_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "CaseHistory_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "CaseNote_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "CompanyOwnership_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "CustomerType_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "Customer_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "Document_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "Exception_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "KYCRequirement_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "OnboardingDecision_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "OwnerScreening_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "OwnershipValidation_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "ReviewCase_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "ReviewSchedule_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "Reviewer_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "RiskRating_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "ValidationIssue_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "ValidationRun_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "Verification_id_seq" AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE;
CREATE SEQUENCE "alert_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1 NO CYCLE;
CREATE SEQUENCE "audit_event_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1 NO CYCLE;
CREATE SEQUENCE "customer_code_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1 NO CYCLE;
CREATE SEQUENCE "exception_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1 NO CYCLE;
CREATE SEQUENCE "review_case_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1 NO CYCLE;
CREATE SEQUENCE "risk_assessment_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1 NO CYCLE;

-- Functions
CREATE OR REPLACE FUNCTION public.alert_guard_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."customer_id" IS DISTINCT FROM OLD."customer_id"
     OR NEW."alert_type" IS DISTINCT FROM OLD."alert_type"
     OR NEW."dedupe_key" IS DISTINCT FROM OLD."dedupe_key"
     OR NEW."alert_code" IS DISTINCT FROM OLD."alert_code"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'An alert identity (customer, type, condition, code, creation date) cannot be changed';
  END IF;
  IF OLD."status" IN ('Resolved', 'Dismissed') THEN
    IF NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."resolved_at" IS DISTINCT FROM OLD."resolved_at"
       OR NEW."resolved_by_id" IS DISTINCT FROM OLD."resolved_by_id"
       OR NEW."resolution_type" IS DISTINCT FROM OLD."resolution_type"
       OR NEW."resolution_notes" IS DISTINCT FROM OLD."resolution_notes"
       OR NEW."severity" IS DISTINCT FROM OLD."severity"
       OR NEW."description" IS DISTINCT FROM OLD."description"
       OR NEW."acknowledged_at" IS DISTINCT FROM OLD."acknowledged_at"
       OR NEW."acknowledged_by_id" IS DISTINCT FROM OLD."acknowledged_by_id" THEN
      RAISE EXCEPTION 'A resolved or dismissed alert is a historical record and cannot be changed. A returning condition creates a new alert';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.audit_event_block_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF coalesce(current_setting('app.allow_history_delete', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Audit events are immutable and cannot be deleted';
  END IF;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.audit_event_block_truncate()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF coalesce(current_setting('app.allow_history_delete', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Audit events are immutable and cannot be truncated';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.audit_event_block_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Audit events are immutable and cannot be updated';
END;
$function$;

CREATE OR REPLACE FUNCTION public.beneficial_owner_company_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."customer_id" IS DISTINCT FROM OLD."customer_id" THEN
    RAISE EXCEPTION 'A beneficial owner cannot be moved to another customer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Customer" WHERE "id" = NEW."customer_id" AND "customer_type_id" = 2) THEN
    RAISE EXCEPTION 'Beneficial owners can only be recorded for company customers';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.company_ownership_mirror()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.document_guard_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."customer_id" IS DISTINCT FROM OLD."customer_id" THEN
    RAISE EXCEPTION 'A document cannot be moved to another customer';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Document status is derived from verification records and cannot be set directly';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.exception_guard_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."status" = 'Resolved' THEN
    RAISE EXCEPTION 'A resolved exception is a historical record and cannot be changed. A returning condition creates a new exception';
  END IF;
  IF NEW."customer_id" IS DISTINCT FROM OLD."customer_id"
     OR NEW."exception_type" IS DISTINCT FROM OLD."exception_type"
     OR NEW."source_entity_type" IS DISTINCT FROM OLD."source_entity_type"
     OR NEW."source_entity_id" IS DISTINCT FROM OLD."source_entity_id"
     OR NEW."dedupe_key" IS DISTINCT FROM OLD."dedupe_key"
     OR NEW."detected_at" IS DISTINCT FROM OLD."detected_at"
     OR NEW."exception_code" IS DISTINCT FROM OLD."exception_code" THEN
    RAISE EXCEPTION 'An exception''s identity (customer, type, source, detection date) cannot be changed';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fill_alert_business_id()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE y INTEGER;
BEGIN
  IF NEW."business_id" IS NULL THEN
    y := EXTRACT(YEAR FROM NEW."created_at")::INTEGER;
    NEW."business_id" := 'ALT-' || y || '-' || lpad(next_scoped_number('ALT', y)::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fill_document_business_id()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE code TEXT;
BEGIN
  IF NEW."business_id" IS NULL THEN
    SELECT "customer_id" INTO code FROM "Customer" WHERE "id" = NEW."customer_id";
    IF code IS NULL THEN
      RAISE EXCEPTION 'insert or update on table "Document" violates foreign key constraint "Document_customer_id_fkey"' USING ERRCODE = '23503';
    END IF;
    NEW."business_id" := 'DOC-' || code || '-' || lpad(next_scoped_number('DOC:' || code, 0)::text, 3, '0');
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fill_requirement_business_id()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE y INTEGER;
BEGIN
  IF NEW."business_id" IS NULL THEN
    y := EXTRACT(YEAR FROM NEW."effective_from")::INTEGER;
    NEW."business_id" := 'KYC-' || y || '-' || lpad(next_scoped_number('KYC', y)::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fill_review_code()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE code TEXT; y INTEGER; n INTEGER;
BEGIN
  IF NEW."review_code" IS NULL THEN
    SELECT "customer_id" INTO code FROM "Customer" WHERE "id" = NEW."customer_id";
    IF code IS NULL THEN
      RAISE EXCEPTION 'insert or update on table "ReviewCase" violates foreign key constraint "ReviewCase_customer_id_fkey"' USING ERRCODE = '23503';
    END IF;
    y := EXTRACT(YEAR FROM NEW."created_at")::INTEGER;
    n := next_scoped_number('REV:' || code, y);
    NEW."review_code" := 'REV-' || code || '-' || y || CASE WHEN n > 1 THEN '-' || lpad(n::text, 2, '0') ELSE '' END;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.forbid_code_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF to_jsonb(OLD) ->> TG_ARGV[0] IS NOT NULL AND to_jsonb(NEW) ->> TG_ARGV[0] IS DISTINCT FROM to_jsonb(OLD) ->> TG_ARGV[0] THEN
    RAISE EXCEPTION '% is a business ID and cannot be changed', TG_ARGV[0];
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.history_block_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF pg_trigger_depth() < 2 AND coalesce(current_setting('app.allow_history_delete', true), '') <> 'on' THEN
    RAISE EXCEPTION '% history cannot be deleted', TG_TABLE_NAME;
  END IF;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.history_block_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION '% records are immutable: record a new one instead', TG_TABLE_NAME;
END;
$function$;

CREATE OR REPLACE FUNCTION public.next_alert_code()
 RETURNS text
 LANGUAGE sql
AS $function$
  SELECT 'ALT-' || lpad(nextval('alert_seq')::text, 6, '0');
$function$;

CREATE OR REPLACE FUNCTION public.next_audit_event_code()
 RETURNS text
 LANGUAGE sql
AS $function$
  SELECT 'AUD-' || lpad(nextval('audit_event_seq')::text, 6, '0');
$function$;

CREATE OR REPLACE FUNCTION public.next_customer_code()
 RETURNS text
 LANGUAGE sql
AS $function$
  SELECT 'CUS-' || lpad(nextval('customer_code_seq')::text, 6, '0');
$function$;

CREATE OR REPLACE FUNCTION public.next_exception_code()
 RETURNS text
 LANGUAGE sql
AS $function$
  SELECT 'EXC-' || lpad(nextval('exception_seq')::text, 6, '0');
$function$;

CREATE OR REPLACE FUNCTION public.next_review_case_code()
 RETURNS text
 LANGUAGE sql
AS $function$
  SELECT 'CASE-' || lpad(nextval('review_case_seq')::text, 6, '0');
$function$;

CREATE OR REPLACE FUNCTION public.next_risk_assessment_code()
 RETURNS text
 LANGUAGE sql
AS $function$
  SELECT 'RSK-' || lpad(nextval('risk_assessment_seq')::text, 6, '0');
$function$;

CREATE OR REPLACE FUNCTION public.next_scoped_number(p_scope text, p_period integer)
 RETURNS integer
 LANGUAGE sql
AS $function$
  INSERT INTO "IdCounter" ("scope", "period", "last_value") VALUES (p_scope, p_period, 1)
  ON CONFLICT ("scope", "period") DO UPDATE SET "last_value" = "IdCounter"."last_value" + 1
  RETURNING "last_value";
$function$;

CREATE OR REPLACE FUNCTION public.onboarding_decision_check_reviewer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.person_ref_for(p_hash text, p_id integer)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN p_hash IS NOT NULL THEN 'PER-' || substr(p_hash, 1, 12) ELSE 'OWN-' || lpad(p_id::text, 6, '0') END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_customer_code_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."customer_id" IS DISTINCT FROM OLD."customer_id" THEN
    RAISE EXCEPTION 'customer_id is immutable';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.review_case_guard_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."customer_id" IS DISTINCT FROM OLD."customer_id"
     OR NEW."case_code" IS DISTINCT FROM OLD."case_code"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'A review case cannot be moved to another customer or change its code';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.review_schedule_guard_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."status" <> 'Scheduled' THEN
    RAISE EXCEPTION 'A completed or superseded review schedule is history and cannot be changed';
  END IF;
  IF NEW."customer_id" IS DISTINCT FROM OLD."customer_id" THEN
    RAISE EXCEPTION 'A review schedule cannot be moved to another customer';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.verification_block_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF coalesce(current_setting('app.allow_history_delete', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Verification history cannot be deleted';
  END IF;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.verification_block_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Verification records are immutable: record a new verification instead';
END;
$function$;

CREATE OR REPLACE FUNCTION public.verification_check_reviewer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.verification_sync_document_status()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE "Document"
     SET "status" = NEW."status", "updated_at" = (now() AT TIME ZONE 'UTC')
   WHERE "id" = NEW."document_id";
  RETURN NEW;
END;
$function$;

-- Tables
CREATE TABLE "Alert" (
    "id" integer DEFAULT nextval('"Alert_id_seq"'::regclass) NOT NULL,
    "alert_code" text DEFAULT next_alert_code() NOT NULL,
    "customer_id" integer NOT NULL,
    "alert_type" text NOT NULL,
    "title" text NOT NULL,
    "description" text NOT NULL,
    "severity" text NOT NULL,
    "related_entity_type" text NOT NULL,
    "related_entity_id" integer,
    "exception_id" integer,
    "dedupe_key" text NOT NULL,
    "status" text DEFAULT 'New'::text NOT NULL,
    "due_date" date,
    "acknowledged_by_id" integer,
    "acknowledged_at" timestamp(3) without time zone,
    "resolved_by_id" integer,
    "resolved_at" timestamp(3) without time zone,
    "resolution_type" text,
    "resolution_notes" text,
    "suppress_regeneration" boolean DEFAULT false NOT NULL,
    "created_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp(3) without time zone NOT NULL,
    "business_id" text NOT NULL,
    "threshold" integer
);

CREATE TABLE "AuditEvent" (
    "id" integer DEFAULT nextval('"AuditEvent_id_seq"'::regclass) NOT NULL,
    "event_code" text DEFAULT next_audit_event_code() NOT NULL,
    "user_id" integer,
    "user_role" text NOT NULL,
    "action_type" text NOT NULL,
    "entity_type" text NOT NULL,
    "entity_id" integer,
    "entity_ref" text,
    "customer_id" integer,
    "previous_values" jsonb,
    "new_values" jsonb,
    "reason" text,
    "ip_address" text,
    "created_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE "BeneficialOwner" (
    "id" integer DEFAULT nextval('"BeneficialOwner_id_seq"'::regclass) NOT NULL,
    "customer_id" integer NOT NULL,
    "full_name" text NOT NULL,
    "date_of_birth" text,
    "country_of_residence" text,
    "nationality" text,
    "ownership_percentage" numeric(5,2),
    "ownership_type" text NOT NULL,
    "control_type" text NOT NULL,
    "pep_status" text DEFAULT 'Unknown'::text NOT NULL,
    "notes" text,
    "identity_hash" text,
    "created_by_id" integer,
    "updated_by_id" integer,
    "created_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp(3) without time zone NOT NULL
);

CREATE TABLE "CaseHistory" (
    "id" integer DEFAULT nextval('"CaseHistory_id_seq"'::regclass) NOT NULL,
    "review_case_id" integer NOT NULL,
    "action" text NOT NULL,
    "previous_status" text,
    "new_status" text NOT NULL,
    "changed_by_id" integer,
    "remarks" text,
    "changed_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE "CaseNote" (
    "id" integer DEFAULT nextval('"CaseNote_id_seq"'::regclass) NOT NULL,
    "review_case_id" integer NOT NULL,
    "author_id" integer NOT NULL,
    "note" text NOT NULL,
    "created_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE "CompanyOwnership" (
    "id" integer DEFAULT nextval('"CompanyOwnership_id_seq"'::regclass) NOT NULL,
    "company_customer_id" integer NOT NULL,
    "beneficial_owner_id" integer NOT NULL,
    "person_ref" text NOT NULL,
    "ownership_percentage" numeric(5,2),
    "ownership_type" text NOT NULL,
    "control_type" text NOT NULL,
    "effective_from" date NOT NULL,
    "effective_to" date,
    "created_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE "Customer" (
    "id" integer DEFAULT nextval('"Customer_id_seq"'::regclass) NOT NULL,
    "customer_id" text NOT NULL,
    "customer_type_id" integer NOT NULL,
    "full_name" text NOT NULL,
    "email" text NOT NULL,
    "phone" text NOT NULL,
    "address" text NOT NULL,
    "country" text NOT NULL,
    "pan_number" text NOT NULL,
    "aadhaar_number" text,
    "pan_hash" text NOT NULL,
    "aadhaar_hash" text,
    "date_of_birth" date,
    "occupation" text,
    "company_registration_number" text,
    "business_activity" text,
    "date_of_incorporation" date,
    "registration_status" text DEFAULT 'Registered'::text NOT NULL,
    "created_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp(3) without time zone NOT NULL
);

CREATE TABLE "CustomerType" (
    "id" integer DEFAULT nextval('"CustomerType_id_seq"'::regclass) NOT NULL,
    "type_name" text NOT NULL
);

CREATE TABLE "Document" (
    "id" integer DEFAULT nextval('"Document_id_seq"'::regclass) NOT NULL,
    "customer_id" integer NOT NULL,
    "requirement_id" integer,
    "document_type" text NOT NULL,
    "document_number" text,
    "document_number_hash" text,
    "issue_date" date NOT NULL,
    "expiry_date" date,
    "submission_date" date NOT NULL,
    "notes" text,
    "file_reference" text,
    "original_file_name" text,
    "file_mime_type" text,
    "file_size_bytes" integer,
    "status" text DEFAULT 'Pending'::text NOT NULL,
    "created_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp(3) without time zone NOT NULL,
    "business_id" text NOT NULL,
    "name_on_document" text
);

CREATE TABLE "Exception" (
    "id" integer DEFAULT nextval('"Exception_id_seq"'::regclass) NOT NULL,
    "exception_code" text DEFAULT next_exception_code() NOT NULL,
    "customer_id" integer NOT NULL,
    "exception_type" text NOT NULL,
    "description" text NOT NULL,
    "severity" text NOT NULL,
    "source_entity_type" text NOT NULL,
    "source_entity_id" integer,
    "dedupe_key" text NOT NULL,
    "status" text DEFAULT 'Open'::text NOT NULL,
    "detected_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "resolved_at" timestamp(3) without time zone,
    "resolved_by_id" integer,
    "resolution_type" text,
    "resolution_notes" text,
    "created_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp(3) without time zone NOT NULL
);

CREATE TABLE "IdCounter" (
    "scope" text NOT NULL,
    "period" integer DEFAULT 0 NOT NULL,
    "last_value" integer DEFAULT 0 NOT NULL
);

CREATE TABLE "KYCRequirement" (
    "id" integer DEFAULT nextval('"KYCRequirement_id_seq"'::regclass) NOT NULL,
    "customer_type_id" integer NOT NULL,
    "risk_level" text NOT NULL,
    "document_type" text NOT NULL,
    "is_mandatory" boolean DEFAULT true NOT NULL,
    "effective_from" date NOT NULL,
    "effective_to" date,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp(3) without time zone NOT NULL,
    "business_id" text NOT NULL
);

CREATE TABLE "OnboardingDecision" (
    "id" integer DEFAULT nextval('"OnboardingDecision_id_seq"'::regclass) NOT NULL,
    "customer_id" integer NOT NULL,
    "decision" text NOT NULL,
    "decided_by_id" integer NOT NULL,
    "decided_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "notes" text,
    "created_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE "OwnerScreening" (
    "id" integer DEFAULT nextval('"OwnerScreening_id_seq"'::regclass) NOT NULL,
    "beneficial_owner_id" integer NOT NULL,
    "screening_type" text NOT NULL,
    "screening_result" text NOT NULL,
    "risk_points" integer NOT NULL,
    "remarks" text,
    "source" text NOT NULL,
    "screened_by_id" integer,
    "screened_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "created_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE "OwnershipValidation" (
    "id" integer DEFAULT nextval('"OwnershipValidation_id_seq"'::regclass) NOT NULL,
    "customer_id" integer NOT NULL,
    "total_ownership_percentage" numeric(7,2) NOT NULL,
    "owner_count" integer NOT NULL,
    "validation_status" text NOT NULL,
    "validation_message" text NOT NULL,
    "checked_by_id" integer,
    "checked_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE "ReviewCase" (
    "id" integer DEFAULT nextval('"ReviewCase_id_seq"'::regclass) NOT NULL,
    "case_code" text DEFAULT next_review_case_code() NOT NULL,
    "customer_id" integer NOT NULL,
    "exception_id" integer,
    "review_schedule_id" integer,
    "periodic_cycle" integer,
    "case_title" text NOT NULL,
    "case_type" text NOT NULL,
    "description" text,
    "priority" text NOT NULL,
    "assigned_analyst_id" integer,
    "assigned_reviewer_id" integer,
    "status" text DEFAULT 'Open'::text NOT NULL,
    "due_date" date NOT NULL,
    "resolution_notes" text,
    "requires_approval" boolean DEFAULT false NOT NULL,
    "proposal_pending" boolean DEFAULT false NOT NULL,
    "proposed_by_id" integer,
    "created_by_id" integer,
    "created_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp(3) without time zone NOT NULL,
    "resolved_at" timestamp(3) without time zone,
    "closed_at" timestamp(3) without time zone,
    "review_code" text NOT NULL
);

CREATE TABLE "ReviewSchedule" (
    "id" integer DEFAULT nextval('"ReviewSchedule_id_seq"'::regclass) NOT NULL,
    "customer_id" integer NOT NULL,
    "cycle_number" integer DEFAULT 1 NOT NULL,
    "risk_level" text NOT NULL,
    "last_review_date" date NOT NULL,
    "next_review_date" date NOT NULL,
    "review_interval_months" integer NOT NULL,
    "status" text DEFAULT 'Scheduled'::text NOT NULL,
    "completed_at" timestamp(3) without time zone,
    "completed_by_id" integer,
    "completion_notes" text,
    "created_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp(3) without time zone NOT NULL
);

CREATE TABLE "Reviewer" (
    "id" integer DEFAULT nextval('"Reviewer_id_seq"'::regclass) NOT NULL,
    "name" text NOT NULL,
    "email" text NOT NULL,
    "role" text NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE "RiskRating" (
    "id" integer DEFAULT nextval('"RiskRating_id_seq"'::regclass) NOT NULL,
    "customer_id" integer NOT NULL,
    "risk_score" integer NOT NULL,
    "risk_level" text NOT NULL,
    "risk_reasons" jsonb NOT NULL,
    "assessment_date" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "assessment_method" text NOT NULL,
    "created_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "assessed_by_id" integer,
    "assessment_status" text DEFAULT 'Completed'::text NOT NULL,
    "previous_risk_level" text,
    "assessment_code" text DEFAULT next_risk_assessment_code() NOT NULL
);

CREATE TABLE "ValidationIssue" (
    "id" integer DEFAULT nextval('"ValidationIssue_id_seq"'::regclass) NOT NULL,
    "validation_run_id" integer NOT NULL,
    "check_code" text NOT NULL,
    "category" text NOT NULL,
    "entity_type" text NOT NULL,
    "entity_id" integer,
    "entity_ref" text,
    "customer_id" integer,
    "issue_type" text NOT NULL,
    "severity" text NOT NULL,
    "description" text NOT NULL,
    "recommended_fix" text NOT NULL,
    "status" text DEFAULT 'Open'::text NOT NULL,
    "resolved_at" timestamp(3) without time zone,
    "fingerprint" text NOT NULL,
    "created_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE "ValidationRun" (
    "id" integer DEFAULT nextval('"ValidationRun_id_seq"'::regclass) NOT NULL,
    "started_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completed_at" timestamp(3) without time zone,
    "as_of" date NOT NULL,
    "total_checks" integer DEFAULT 0 NOT NULL,
    "passed_checks" integer DEFAULT 0 NOT NULL,
    "failed_checks" integer DEFAULT 0 NOT NULL,
    "warning_count" integer DEFAULT 0 NOT NULL,
    "status" text DEFAULT 'Running'::text NOT NULL,
    "results" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "created_by_id" integer
);

CREATE TABLE "Verification" (
    "id" integer DEFAULT nextval('"Verification_id_seq"'::regclass) NOT NULL,
    "document_id" integer NOT NULL,
    "reviewer_id" integer,
    "status" text NOT NULL,
    "remarks" text,
    "verification_date" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "created_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Primary keys, unique and check constraints
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_pkey" PRIMARY KEY (id);
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_pkey" PRIMARY KEY (id);
ALTER TABLE "BeneficialOwner" ADD CONSTRAINT "BeneficialOwner_pkey" PRIMARY KEY (id);
ALTER TABLE "CaseHistory" ADD CONSTRAINT "CaseHistory_pkey" PRIMARY KEY (id);
ALTER TABLE "CaseNote" ADD CONSTRAINT "CaseNote_pkey" PRIMARY KEY (id);
ALTER TABLE "CompanyOwnership" ADD CONSTRAINT "CompanyOwnership_pkey" PRIMARY KEY (id);
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_pkey" PRIMARY KEY (id);
ALTER TABLE "CustomerType" ADD CONSTRAINT "CustomerType_pkey" PRIMARY KEY (id);
ALTER TABLE "Document" ADD CONSTRAINT "Document_pkey" PRIMARY KEY (id);
ALTER TABLE "Exception" ADD CONSTRAINT "Exception_pkey" PRIMARY KEY (id);
ALTER TABLE "IdCounter" ADD CONSTRAINT "IdCounter_pkey" PRIMARY KEY (scope, period);
ALTER TABLE "KYCRequirement" ADD CONSTRAINT "KYCRequirement_pkey" PRIMARY KEY (id);
ALTER TABLE "OnboardingDecision" ADD CONSTRAINT "OnboardingDecision_pkey" PRIMARY KEY (id);
ALTER TABLE "OwnerScreening" ADD CONSTRAINT "OwnerScreening_pkey" PRIMARY KEY (id);
ALTER TABLE "OwnershipValidation" ADD CONSTRAINT "OwnershipValidation_pkey" PRIMARY KEY (id);
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_pkey" PRIMARY KEY (id);
ALTER TABLE "ReviewSchedule" ADD CONSTRAINT "ReviewSchedule_pkey" PRIMARY KEY (id);
ALTER TABLE "Reviewer" ADD CONSTRAINT "Reviewer_pkey" PRIMARY KEY (id);
ALTER TABLE "RiskRating" ADD CONSTRAINT "RiskRating_pkey" PRIMARY KEY (id);
ALTER TABLE "ValidationIssue" ADD CONSTRAINT "ValidationIssue_pkey" PRIMARY KEY (id);
ALTER TABLE "ValidationRun" ADD CONSTRAINT "ValidationRun_pkey" PRIMARY KEY (id);
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_pkey" PRIMARY KEY (id);
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_business_id_check" CHECK ((business_id ~ '^ALT-[0-9]{4}-[0-9]{6,}$'::text));
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_closed_check" CHECK (((status <> ALL (ARRAY['Resolved'::text, 'Dismissed'::text])) OR ((resolved_at IS NOT NULL) AND (resolution_type IS NOT NULL) AND (length(btrim(COALESCE(resolution_notes, ''::text))) > 0))));
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_code_format_check" CHECK ((alert_code ~ '^ALT-[0-9]{6,}$'::text));
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_dismissed_check" CHECK (((status <> 'Dismissed'::text) OR (resolution_type = 'Dismissed manually'::text)));
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_manual_close_check" CHECK (((resolution_type IS NULL) OR (resolution_type = 'Condition cleared'::text) OR (resolved_by_id IS NOT NULL)));
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_related_type_check" CHECK ((related_entity_type = ANY (ARRAY['Document'::text, 'KYCRequirement'::text, 'BeneficialOwner'::text, 'Customer'::text, 'ReviewSchedule'::text, 'ReviewCase'::text])));
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_resolution_type_check" CHECK (((resolution_type IS NULL) OR (resolution_type = ANY (ARRAY['Condition cleared'::text, 'Resolved manually'::text, 'Dismissed manually'::text]))));
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_severity_check" CHECK ((severity = ANY (ARRAY['Low'::text, 'Medium'::text, 'High'::text, 'Critical'::text])));
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_status_check" CHECK ((status = ANY (ARRAY['New'::text, 'Acknowledged'::text, 'In Progress'::text, 'Resolved'::text, 'Dismissed'::text])));
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_threshold_check" CHECK (((threshold IS NULL) OR (threshold > 0)));
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_title_check" CHECK ((length(btrim(title)) > 0));
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_type_check" CHECK ((alert_type = ANY (ARRAY['DOCUMENT_EXPIRY'::text, 'DOCUMENT_EXPIRED'::text, 'MISSING_MANDATORY_DOCUMENT'::text, 'VERIFICATION_PENDING'::text, 'HIGH_RISK_CUSTOMER'::text, 'OWNERSHIP_ISSUE'::text, 'PERIODIC_REVIEW_DUE'::text, 'PERIODIC_REVIEW_OVERDUE'::text, 'POTENTIAL_PEP_MATCH'::text, 'POTENTIAL_SANCTIONS_MATCH'::text])));
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_action_check" CHECK (((length(btrim(action_type)) > 0) AND (length(btrim(entity_type)) > 0)));
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actor_check" CHECK ((((user_id IS NULL) AND (user_role = 'System'::text)) OR ((user_id IS NOT NULL) AND (user_role <> 'System'::text))));
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_code_format_check" CHECK ((event_code ~ '^AUD-[0-9]{6,}$'::text));
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_role_check" CHECK ((user_role = ANY (ARRAY['Analyst'::text, 'Reviewer'::text, 'Admin'::text, 'System'::text])));
ALTER TABLE "BeneficialOwner" ADD CONSTRAINT "BeneficialOwner_control_type_check" CHECK ((length(btrim(control_type)) > 0));
ALTER TABLE "BeneficialOwner" ADD CONSTRAINT "BeneficialOwner_country_check" CHECK ((((country_of_residence IS NULL) OR (country_of_residence ~ '^[A-Z]{2}$'::text)) AND ((nationality IS NULL) OR (nationality ~ '^[A-Z]{2}$'::text))));
ALTER TABLE "BeneficialOwner" ADD CONSTRAINT "BeneficialOwner_name_check" CHECK ((length(btrim(full_name)) > 0));
ALTER TABLE "BeneficialOwner" ADD CONSTRAINT "BeneficialOwner_ownership_type_check" CHECK ((ownership_type = ANY (ARRAY['Direct'::text, 'Indirect'::text])));
ALTER TABLE "BeneficialOwner" ADD CONSTRAINT "BeneficialOwner_pep_status_check" CHECK ((pep_status = ANY (ARRAY['Yes'::text, 'No'::text, 'Unknown'::text])));
ALTER TABLE "BeneficialOwner" ADD CONSTRAINT "BeneficialOwner_percentage_check" CHECK (((ownership_percentage IS NULL) OR ((ownership_percentage > (0)::numeric) AND (ownership_percentage <= (100)::numeric))));
ALTER TABLE "CaseHistory" ADD CONSTRAINT "CaseHistory_action_check" CHECK ((length(btrim(action)) > 0));
ALTER TABLE "CaseHistory" ADD CONSTRAINT "CaseHistory_new_status_check" CHECK ((new_status = ANY (ARRAY['Open'::text, 'Assigned'::text, 'In Progress'::text, 'Pending Customer'::text, 'Escalated'::text, 'Resolved'::text, 'Closed'::text])));
ALTER TABLE "CaseHistory" ADD CONSTRAINT "CaseHistory_previous_status_check" CHECK (((previous_status IS NULL) OR (previous_status = ANY (ARRAY['Open'::text, 'Assigned'::text, 'In Progress'::text, 'Pending Customer'::text, 'Escalated'::text, 'Resolved'::text, 'Closed'::text]))));
ALTER TABLE "CaseNote" ADD CONSTRAINT "CaseNote_note_check" CHECK ((length(btrim(note)) > 0));
ALTER TABLE "CompanyOwnership" ADD CONSTRAINT "CompanyOwnership_dates_check" CHECK (((effective_to IS NULL) OR (effective_to >= effective_from)));
ALTER TABLE "CompanyOwnership" ADD CONSTRAINT "CompanyOwnership_pct_check" CHECK (((ownership_percentage IS NULL) OR ((ownership_percentage > (0)::numeric) AND (ownership_percentage <= (100)::numeric))));
ALTER TABLE "CompanyOwnership" ADD CONSTRAINT "CompanyOwnership_type_check" CHECK ((ownership_type = ANY (ARRAY['Direct'::text, 'Indirect'::text])));
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_code_format_check" CHECK ((customer_id ~ '^CUS-[0-9]{6,}$'::text));
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_name_not_blank_check" CHECK ((length(btrim(full_name)) > 0));
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_status_check" CHECK ((registration_status = ANY (ARRAY['Registered'::text, 'Pending Review'::text, 'Closed'::text])));
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_type_fields_check" CHECK ((((customer_type_id = 1) AND (date_of_birth IS NOT NULL) AND (aadhaar_number IS NOT NULL) AND (aadhaar_hash IS NOT NULL) AND (company_registration_number IS NULL) AND (business_activity IS NULL) AND (date_of_incorporation IS NULL)) OR ((customer_type_id = 2) AND (company_registration_number IS NOT NULL) AND (business_activity IS NOT NULL) AND (date_of_incorporation IS NOT NULL) AND (date_of_birth IS NULL) AND (aadhaar_number IS NULL) AND (aadhaar_hash IS NULL))));
ALTER TABLE "CustomerType" ADD CONSTRAINT "CustomerType_name_check" CHECK ((type_name = ANY (ARRAY['Individual'::text, 'Company'::text])));
ALTER TABLE "Document" ADD CONSTRAINT "Document_business_id_check" CHECK ((business_id ~ '^DOC-CUS-[0-9]{6,}-[0-9]{3,}$'::text));
ALTER TABLE "Document" ADD CONSTRAINT "Document_dates_check" CHECK ((((expiry_date IS NULL) OR (expiry_date >= issue_date)) AND (submission_date >= issue_date)));
ALTER TABLE "Document" ADD CONSTRAINT "Document_doc_type_check" CHECK ((length(btrim(document_type)) > 0));
ALTER TABLE "Document" ADD CONSTRAINT "Document_file_meta_check" CHECK ((((file_reference IS NULL) AND (original_file_name IS NULL) AND (file_mime_type IS NULL) AND (file_size_bytes IS NULL)) OR ((file_reference IS NOT NULL) AND (original_file_name IS NOT NULL) AND (file_mime_type IS NOT NULL) AND (file_size_bytes IS NOT NULL) AND (file_size_bytes > 0) AND (file_size_bytes <= 10485760))));
ALTER TABLE "Document" ADD CONSTRAINT "Document_name_on_document_check" CHECK (((name_on_document IS NULL) OR (length(btrim(name_on_document)) > 0)));
ALTER TABLE "Document" ADD CONSTRAINT "Document_number_pair_check" CHECK (((document_number IS NULL) = (document_number_hash IS NULL)));
ALTER TABLE "Document" ADD CONSTRAINT "Document_status_check" CHECK ((status = ANY (ARRAY['Pending'::text, 'In Review'::text, 'Verified'::text, 'Rejected'::text, 'Requires Resubmission'::text])));
ALTER TABLE "Exception" ADD CONSTRAINT "Exception_code_format_check" CHECK ((exception_code ~ '^EXC-[0-9]{6,}$'::text));
ALTER TABLE "Exception" ADD CONSTRAINT "Exception_resolution_check" CHECK (((status <> 'Resolved'::text) OR ((resolved_at IS NOT NULL) AND (resolution_type IS NOT NULL) AND (length(btrim(COALESCE(resolution_notes, ''::text))) > 0))));
ALTER TABLE "Exception" ADD CONSTRAINT "Exception_resolution_type_check" CHECK (((resolution_type IS NULL) OR (resolution_type = ANY (ARRAY['Condition cleared'::text, 'Resolved manually'::text]))));
ALTER TABLE "Exception" ADD CONSTRAINT "Exception_severity_check" CHECK ((severity = ANY (ARRAY['Low'::text, 'Medium'::text, 'High'::text, 'Critical'::text])));
ALTER TABLE "Exception" ADD CONSTRAINT "Exception_source_type_check" CHECK ((source_entity_type = ANY (ARRAY['Document'::text, 'KYCRequirement'::text, 'BeneficialOwner'::text, 'Customer'::text, 'ReviewSchedule'::text, 'ReviewCase'::text])));
ALTER TABLE "Exception" ADD CONSTRAINT "Exception_status_check" CHECK ((status = ANY (ARRAY['Open'::text, 'In Review'::text, 'Resolved'::text])));
ALTER TABLE "Exception" ADD CONSTRAINT "Exception_type_check" CHECK ((exception_type = ANY (ARRAY['MANDATORY_DOCUMENT_MISSING'::text, 'DOCUMENT_EXPIRED'::text, 'DOCUMENT_EXPIRING_SOON'::text, 'DOCUMENT_REJECTED'::text, 'DOCUMENT_AWAITING_VERIFICATION'::text, 'DOCUMENT_REQUIRES_RESUBMISSION'::text, 'OWNERSHIP_NO_OWNERS'::text, 'OWNERSHIP_EXCEEDS_100'::text, 'OWNERSHIP_INCOMPLETE'::text, 'OWNERSHIP_REQUIRES_INVESTIGATION'::text, 'HIGH_RISK_CUSTOMER'::text, 'POTENTIAL_PEP_MATCH'::text, 'POTENTIAL_SANCTIONS_MATCH'::text, 'CONFIRMED_SANCTIONS_MATCH'::text, 'RISK_MANUAL_REVIEW_REQUIRED'::text, 'PERIODIC_REVIEW_OVERDUE'::text, 'PERIODIC_REVIEW_DUE_SOON'::text, 'PREVIOUS_REVIEW_UNRESOLVED'::text])));
ALTER TABLE "IdCounter" ADD CONSTRAINT "IdCounter_value_check" CHECK ((last_value >= 0));
ALTER TABLE "KYCRequirement" ADD CONSTRAINT "KYCRequirement_business_id_check" CHECK ((business_id ~ '^KYC-[0-9]{4}-[0-9]{6,}$'::text));
ALTER TABLE "KYCRequirement" ADD CONSTRAINT "KYCRequirement_dates_check" CHECK (((effective_to IS NULL) OR (effective_to >= effective_from)));
ALTER TABLE "KYCRequirement" ADD CONSTRAINT "KYCRequirement_doc_type_check" CHECK ((length(btrim(document_type)) > 0));
ALTER TABLE "KYCRequirement" ADD CONSTRAINT "KYCRequirement_risk_check" CHECK ((risk_level = ANY (ARRAY['Low'::text, 'Medium'::text, 'High'::text])));
ALTER TABLE "OnboardingDecision" ADD CONSTRAINT "OnboardingDecision_decision_check" CHECK ((decision = ANY (ARRAY['Approved'::text, 'Rejected'::text, 'Pending Review'::text])));
ALTER TABLE "OnboardingDecision" ADD CONSTRAINT "OnboardingDecision_reason_check" CHECK (((decision = 'Pending Review'::text) OR (length(btrim(COALESCE(notes, ''::text))) > 0)));
ALTER TABLE "OwnerScreening" ADD CONSTRAINT "OwnerScreening_points_check" CHECK ((risk_points >= 0));
ALTER TABLE "OwnerScreening" ADD CONSTRAINT "OwnerScreening_remarks_check" CHECK (((screening_result = 'No Match'::text) OR (length(btrim(COALESCE(remarks, ''::text))) > 0)));
ALTER TABLE "OwnerScreening" ADD CONSTRAINT "OwnerScreening_result_check" CHECK ((screening_result = ANY (ARRAY['Confirmed'::text, 'Potential Match'::text, 'No Match'::text])));
ALTER TABLE "OwnerScreening" ADD CONSTRAINT "OwnerScreening_source_check" CHECK ((source = ANY (ARRAY['Simulated list match'::text, 'Manual entry (synthetic)'::text])));
ALTER TABLE "OwnerScreening" ADD CONSTRAINT "OwnerScreening_type_check" CHECK ((screening_type = ANY (ARRAY['PEP'::text, 'Sanctions'::text])));
ALTER TABLE "OwnershipValidation" ADD CONSTRAINT "OwnershipValidation_status_check" CHECK ((validation_status = ANY (ARRAY['RECONCILED'::text, 'EXCEEDS_100'::text, 'BELOW_100'::text, 'NO_OWNERS'::text, 'MISSING_PERCENTAGE'::text])));
ALTER TABLE "OwnershipValidation" ADD CONSTRAINT "OwnershipValidation_total_check" CHECK (((total_ownership_percentage >= (0)::numeric) AND (owner_count >= 0)));
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_code_format_check" CHECK ((case_code ~ '^CASE-[0-9]{6,}$'::text));
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_dates_check" CHECK ((((status <> 'Resolved'::text) OR (resolved_at IS NOT NULL)) AND ((status <> 'Closed'::text) OR (closed_at IS NOT NULL))));
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_periodic_check" CHECK (((review_schedule_id IS NULL) OR (periodic_cycle IS NOT NULL)));
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_priority_check" CHECK ((priority = ANY (ARRAY['Low'::text, 'Medium'::text, 'High'::text, 'Critical'::text])));
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_review_code_check" CHECK ((review_code ~ '^REV-CUS-[0-9]{6,}-[0-9]{4}(-[0-9]{2,})?$'::text));
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_status_check" CHECK ((status = ANY (ARRAY['Open'::text, 'Assigned'::text, 'In Progress'::text, 'Pending Customer'::text, 'Escalated'::text, 'Resolved'::text, 'Closed'::text])));
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_title_check" CHECK ((length(btrim(case_title)) > 0));
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_type_check" CHECK ((case_type = ANY (ARRAY['Missing Documents'::text, 'Expired Documents'::text, 'Verification Issues'::text, 'Ownership Issues'::text, 'High-Risk Review'::text, 'PEP Investigation'::text, 'Sanctions Investigation'::text, 'Periodic KYC Review'::text, 'Other'::text])));
ALTER TABLE "ReviewSchedule" ADD CONSTRAINT "ReviewSchedule_completion_check" CHECK (((status <> 'Completed'::text) OR ((completed_at IS NOT NULL) AND (length(btrim(COALESCE(completion_notes, ''::text))) > 0))));
ALTER TABLE "ReviewSchedule" ADD CONSTRAINT "ReviewSchedule_cycle_check" CHECK ((cycle_number >= 1));
ALTER TABLE "ReviewSchedule" ADD CONSTRAINT "ReviewSchedule_dates_check" CHECK ((next_review_date > last_review_date));
ALTER TABLE "ReviewSchedule" ADD CONSTRAINT "ReviewSchedule_interval_check" CHECK (((review_interval_months >= 1) AND (review_interval_months <= 120)));
ALTER TABLE "ReviewSchedule" ADD CONSTRAINT "ReviewSchedule_risk_check" CHECK ((risk_level = ANY (ARRAY['Low'::text, 'Medium'::text, 'High'::text])));
ALTER TABLE "ReviewSchedule" ADD CONSTRAINT "ReviewSchedule_status_check" CHECK ((status = ANY (ARRAY['Scheduled'::text, 'Completed'::text, 'Superseded'::text])));
ALTER TABLE "Reviewer" ADD CONSTRAINT "Reviewer_role_check" CHECK ((role = ANY (ARRAY['Analyst'::text, 'Reviewer'::text, 'Admin'::text])));
ALTER TABLE "RiskRating" ADD CONSTRAINT "RiskRating_code_format_check" CHECK ((assessment_code ~ '^RSK-[0-9]{6,}$'::text));
ALTER TABLE "RiskRating" ADD CONSTRAINT "RiskRating_level_check" CHECK ((risk_level = ANY (ARRAY['Low'::text, 'Medium'::text, 'High'::text])));
ALTER TABLE "RiskRating" ADD CONSTRAINT "RiskRating_previous_level_check" CHECK (((previous_risk_level IS NULL) OR (previous_risk_level = ANY (ARRAY['Low'::text, 'Medium'::text, 'High'::text]))));
ALTER TABLE "RiskRating" ADD CONSTRAINT "RiskRating_score_check" CHECK (((risk_score >= 0) AND (risk_score <= 100)));
ALTER TABLE "RiskRating" ADD CONSTRAINT "RiskRating_status_check" CHECK ((assessment_status = ANY (ARRAY['Completed'::text, 'Requires Manual Review'::text])));
ALTER TABLE "ValidationIssue" ADD CONSTRAINT "ValidationIssue_severity_check" CHECK ((severity = ANY (ARRAY['Error'::text, 'Warning'::text])));
ALTER TABLE "ValidationIssue" ADD CONSTRAINT "ValidationIssue_status_check" CHECK ((status = ANY (ARRAY['Open'::text, 'Resolved'::text])));
ALTER TABLE "ValidationRun" ADD CONSTRAINT "ValidationRun_counts_check" CHECK (((total_checks >= 0) AND (passed_checks >= 0) AND (failed_checks >= 0) AND (warning_count >= 0) AND (((passed_checks + failed_checks) + warning_count) = total_checks)));
ALTER TABLE "ValidationRun" ADD CONSTRAINT "ValidationRun_status_check" CHECK ((status = ANY (ARRAY['Running'::text, 'Completed'::text, 'Failed'::text])));
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_remarks_check" CHECK (((status <> ALL (ARRAY['Rejected'::text, 'Requires Resubmission'::text])) OR (length(btrim(COALESCE(remarks, ''::text))) > 0)));
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_reviewer_check" CHECK (((status = 'Pending'::text) OR (reviewer_id IS NOT NULL)));
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_status_check" CHECK ((status = ANY (ARRAY['Pending'::text, 'In Review'::text, 'Verified'::text, 'Rejected'::text, 'Requires Resubmission'::text])));

-- Sequence ownership
ALTER SEQUENCE "Alert_id_seq" OWNED BY "Alert"."id";
ALTER SEQUENCE "AuditEvent_id_seq" OWNED BY "AuditEvent"."id";
ALTER SEQUENCE "BeneficialOwner_id_seq" OWNED BY "BeneficialOwner"."id";
ALTER SEQUENCE "CaseHistory_id_seq" OWNED BY "CaseHistory"."id";
ALTER SEQUENCE "CaseNote_id_seq" OWNED BY "CaseNote"."id";
ALTER SEQUENCE "CompanyOwnership_id_seq" OWNED BY "CompanyOwnership"."id";
ALTER SEQUENCE "CustomerType_id_seq" OWNED BY "CustomerType"."id";
ALTER SEQUENCE "Customer_id_seq" OWNED BY "Customer"."id";
ALTER SEQUENCE "Document_id_seq" OWNED BY "Document"."id";
ALTER SEQUENCE "Exception_id_seq" OWNED BY "Exception"."id";
ALTER SEQUENCE "KYCRequirement_id_seq" OWNED BY "KYCRequirement"."id";
ALTER SEQUENCE "OnboardingDecision_id_seq" OWNED BY "OnboardingDecision"."id";
ALTER SEQUENCE "OwnerScreening_id_seq" OWNED BY "OwnerScreening"."id";
ALTER SEQUENCE "OwnershipValidation_id_seq" OWNED BY "OwnershipValidation"."id";
ALTER SEQUENCE "ReviewCase_id_seq" OWNED BY "ReviewCase"."id";
ALTER SEQUENCE "ReviewSchedule_id_seq" OWNED BY "ReviewSchedule"."id";
ALTER SEQUENCE "Reviewer_id_seq" OWNED BY "Reviewer"."id";
ALTER SEQUENCE "RiskRating_id_seq" OWNED BY "RiskRating"."id";
ALTER SEQUENCE "ValidationIssue_id_seq" OWNED BY "ValidationIssue"."id";
ALTER SEQUENCE "ValidationRun_id_seq" OWNED BY "ValidationRun"."id";
ALTER SEQUENCE "Verification_id_seq" OWNED BY "Verification"."id";

-- Indexes
CREATE UNIQUE INDEX "Alert_active_dedupe_key" ON public."Alert" USING btree (dedupe_key) WHERE (status <> ALL (ARRAY['Resolved'::text, 'Dismissed'::text]));
CREATE UNIQUE INDEX "Alert_alert_code_key" ON public."Alert" USING btree (alert_code);
CREATE INDEX "Alert_alert_type_status_idx" ON public."Alert" USING btree (alert_type, status);
CREATE UNIQUE INDEX "Alert_business_id_key" ON public."Alert" USING btree (business_id);
CREATE INDEX "Alert_created_at_idx" ON public."Alert" USING btree (created_at);
CREATE INDEX "Alert_customer_id_status_idx" ON public."Alert" USING btree (customer_id, status);
CREATE INDEX "Alert_dedupe_key_idx" ON public."Alert" USING btree (dedupe_key);
CREATE INDEX "Alert_severity_status_idx" ON public."Alert" USING btree (severity, status);
CREATE INDEX "AuditEvent_action_type_idx" ON public."AuditEvent" USING btree (action_type);
CREATE INDEX "AuditEvent_created_at_idx" ON public."AuditEvent" USING btree (created_at);
CREATE INDEX "AuditEvent_customer_id_created_at_idx" ON public."AuditEvent" USING btree (customer_id, created_at);
CREATE INDEX "AuditEvent_entity_type_entity_id_idx" ON public."AuditEvent" USING btree (entity_type, entity_id);
CREATE UNIQUE INDEX "AuditEvent_event_code_key" ON public."AuditEvent" USING btree (event_code);
CREATE INDEX "AuditEvent_user_id_idx" ON public."AuditEvent" USING btree (user_id);
CREATE UNIQUE INDEX "BeneficialOwner_customer_id_identity_hash_key" ON public."BeneficialOwner" USING btree (customer_id, identity_hash);
CREATE INDEX "BeneficialOwner_customer_id_idx" ON public."BeneficialOwner" USING btree (customer_id);
CREATE INDEX "BeneficialOwner_full_name_idx" ON public."BeneficialOwner" USING btree (full_name);
CREATE INDEX "CaseHistory_review_case_id_id_idx" ON public."CaseHistory" USING btree (review_case_id, id);
CREATE INDEX "CaseNote_review_case_id_id_idx" ON public."CaseNote" USING btree (review_case_id, id);
CREATE INDEX "CompanyOwnership_company_idx" ON public."CompanyOwnership" USING btree (company_customer_id, effective_to);
CREATE UNIQUE INDEX "CompanyOwnership_one_active_per_pair" ON public."CompanyOwnership" USING btree (company_customer_id, beneficial_owner_id) WHERE (effective_to IS NULL);
CREATE INDEX "CompanyOwnership_owner_idx" ON public."CompanyOwnership" USING btree (beneficial_owner_id);
CREATE INDEX "CompanyOwnership_person_idx" ON public."CompanyOwnership" USING btree (person_ref);
CREATE UNIQUE INDEX "Customer_aadhaar_hash_key" ON public."Customer" USING btree (aadhaar_hash);
CREATE UNIQUE INDEX "Customer_company_registration_number_key" ON public."Customer" USING btree (company_registration_number);
CREATE INDEX "Customer_created_at_idx" ON public."Customer" USING btree (created_at);
CREATE UNIQUE INDEX "Customer_customer_id_key" ON public."Customer" USING btree (customer_id);
CREATE INDEX "Customer_customer_type_id_idx" ON public."Customer" USING btree (customer_type_id);
CREATE INDEX "Customer_full_name_idx" ON public."Customer" USING btree (full_name);
CREATE UNIQUE INDEX "Customer_pan_hash_key" ON public."Customer" USING btree (pan_hash);
CREATE UNIQUE INDEX "CustomerType_type_name_key" ON public."CustomerType" USING btree (type_name);
CREATE UNIQUE INDEX "Document_business_id_key" ON public."Document" USING btree (business_id);
CREATE UNIQUE INDEX "Document_customer_id_document_type_document_number_hash_iss_key" ON public."Document" USING btree (customer_id, document_type, document_number_hash, issue_date, submission_date);
CREATE INDEX "Document_customer_id_idx" ON public."Document" USING btree (customer_id);
CREATE INDEX "Document_document_type_idx" ON public."Document" USING btree (document_type);
CREATE INDEX "Document_expiry_date_idx" ON public."Document" USING btree (expiry_date);
CREATE INDEX "Document_status_idx" ON public."Document" USING btree (status);
CREATE UNIQUE INDEX "Exception_active_dedupe_key" ON public."Exception" USING btree (dedupe_key) WHERE (status <> 'Resolved'::text);
CREATE INDEX "Exception_customer_id_status_idx" ON public."Exception" USING btree (customer_id, status);
CREATE INDEX "Exception_dedupe_key_idx" ON public."Exception" USING btree (dedupe_key);
CREATE UNIQUE INDEX "Exception_exception_code_key" ON public."Exception" USING btree (exception_code);
CREATE INDEX "Exception_exception_type_status_idx" ON public."Exception" USING btree (exception_type, status);
CREATE INDEX "Exception_severity_status_idx" ON public."Exception" USING btree (severity, status);
CREATE UNIQUE INDEX "KYCRequirement_business_id_key" ON public."KYCRequirement" USING btree (business_id);
CREATE UNIQUE INDEX "KYCRequirement_customer_type_id_risk_level_document_type_ef_key" ON public."KYCRequirement" USING btree (customer_type_id, risk_level, document_type, effective_from);
CREATE INDEX "KYCRequirement_customer_type_id_risk_level_is_active_idx" ON public."KYCRequirement" USING btree (customer_type_id, risk_level, is_active);
CREATE INDEX "OnboardingDecision_customer_id_decided_at_idx" ON public."OnboardingDecision" USING btree (customer_id, decided_at);
CREATE UNIQUE INDEX "OnboardingDecision_one_final_per_customer" ON public."OnboardingDecision" USING btree (customer_id) WHERE (decision = ANY (ARRAY['Approved'::text, 'Rejected'::text]));
CREATE INDEX "OwnerScreening_beneficial_owner_id_screening_type_id_idx" ON public."OwnerScreening" USING btree (beneficial_owner_id, screening_type, id);
CREATE INDEX "OwnershipValidation_customer_id_id_idx" ON public."OwnershipValidation" USING btree (customer_id, id);
CREATE INDEX "ReviewCase_assigned_analyst_id_status_idx" ON public."ReviewCase" USING btree (assigned_analyst_id, status);
CREATE INDEX "ReviewCase_assigned_reviewer_id_status_idx" ON public."ReviewCase" USING btree (assigned_reviewer_id, status);
CREATE UNIQUE INDEX "ReviewCase_case_code_key" ON public."ReviewCase" USING btree (case_code);
CREATE INDEX "ReviewCase_customer_id_status_idx" ON public."ReviewCase" USING btree (customer_id, status);
CREATE INDEX "ReviewCase_due_date_idx" ON public."ReviewCase" USING btree (due_date);
CREATE INDEX "ReviewCase_exception_id_idx" ON public."ReviewCase" USING btree (exception_id);
CREATE UNIQUE INDEX "ReviewCase_one_active_periodic_per_cycle" ON public."ReviewCase" USING btree (customer_id, periodic_cycle) WHERE ((case_type = 'Periodic KYC Review'::text) AND (periodic_cycle IS NOT NULL) AND (status <> ALL (ARRAY['Resolved'::text, 'Closed'::text])));
CREATE UNIQUE INDEX "ReviewCase_review_code_key" ON public."ReviewCase" USING btree (review_code);
CREATE INDEX "ReviewCase_status_priority_idx" ON public."ReviewCase" USING btree (status, priority);
CREATE INDEX "ReviewSchedule_customer_id_status_idx" ON public."ReviewSchedule" USING btree (customer_id, status);
CREATE UNIQUE INDEX "ReviewSchedule_one_scheduled_per_customer" ON public."ReviewSchedule" USING btree (customer_id) WHERE (status = 'Scheduled'::text);
CREATE INDEX "ReviewSchedule_status_next_review_date_idx" ON public."ReviewSchedule" USING btree (status, next_review_date);
CREATE UNIQUE INDEX "Reviewer_email_key" ON public."Reviewer" USING btree (email);
CREATE UNIQUE INDEX "RiskRating_assessment_code_key" ON public."RiskRating" USING btree (assessment_code);
CREATE INDEX "RiskRating_assessment_status_idx" ON public."RiskRating" USING btree (assessment_status);
CREATE INDEX "RiskRating_customer_id_assessment_date_idx" ON public."RiskRating" USING btree (customer_id, assessment_date);
CREATE INDEX "RiskRating_risk_level_idx" ON public."RiskRating" USING btree (risk_level);
CREATE INDEX "ValidationIssue_fingerprint_idx" ON public."ValidationIssue" USING btree (fingerprint);
CREATE INDEX "ValidationIssue_status_severity_idx" ON public."ValidationIssue" USING btree (status, severity);
CREATE INDEX "ValidationIssue_validation_run_id_severity_idx" ON public."ValidationIssue" USING btree (validation_run_id, severity);
CREATE INDEX "ValidationRun_started_at_idx" ON public."ValidationRun" USING btree (started_at);
CREATE INDEX "Verification_document_id_id_idx" ON public."Verification" USING btree (document_id, id);
CREATE INDEX "Verification_reviewer_id_idx" ON public."Verification" USING btree (reviewer_id);

-- Foreign keys
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_acknowledged_by_id_fkey" FOREIGN KEY (acknowledged_by_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES "Customer"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_exception_id_fkey" FOREIGN KEY (exception_id) REFERENCES "Exception"(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_resolved_by_id_fkey" FOREIGN KEY (resolved_by_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_user_id_fkey" FOREIGN KEY (user_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "BeneficialOwner" ADD CONSTRAINT "BeneficialOwner_created_by_id_fkey" FOREIGN KEY (created_by_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "BeneficialOwner" ADD CONSTRAINT "BeneficialOwner_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES "Customer"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "BeneficialOwner" ADD CONSTRAINT "BeneficialOwner_updated_by_id_fkey" FOREIGN KEY (updated_by_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "CaseHistory" ADD CONSTRAINT "CaseHistory_changed_by_id_fkey" FOREIGN KEY (changed_by_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "CaseHistory" ADD CONSTRAINT "CaseHistory_review_case_id_fkey" FOREIGN KEY (review_case_id) REFERENCES "ReviewCase"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "CaseNote" ADD CONSTRAINT "CaseNote_author_id_fkey" FOREIGN KEY (author_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "CaseNote" ADD CONSTRAINT "CaseNote_review_case_id_fkey" FOREIGN KEY (review_case_id) REFERENCES "ReviewCase"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "CompanyOwnership" ADD CONSTRAINT "CompanyOwnership_company_fkey" FOREIGN KEY (company_customer_id) REFERENCES "Customer"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "CompanyOwnership" ADD CONSTRAINT "CompanyOwnership_owner_fkey" FOREIGN KEY (beneficial_owner_id) REFERENCES "BeneficialOwner"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_customer_type_id_fkey" FOREIGN KEY (customer_type_id) REFERENCES "CustomerType"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "Document" ADD CONSTRAINT "Document_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES "Customer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "Document" ADD CONSTRAINT "Document_requirement_id_fkey" FOREIGN KEY (requirement_id) REFERENCES "KYCRequirement"(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "Exception" ADD CONSTRAINT "Exception_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES "Customer"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "Exception" ADD CONSTRAINT "Exception_resolved_by_id_fkey" FOREIGN KEY (resolved_by_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "KYCRequirement" ADD CONSTRAINT "KYCRequirement_customer_type_id_fkey" FOREIGN KEY (customer_type_id) REFERENCES "CustomerType"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "OnboardingDecision" ADD CONSTRAINT "OnboardingDecision_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES "Customer"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "OnboardingDecision" ADD CONSTRAINT "OnboardingDecision_decided_by_id_fkey" FOREIGN KEY (decided_by_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "OwnerScreening" ADD CONSTRAINT "OwnerScreening_beneficial_owner_id_fkey" FOREIGN KEY (beneficial_owner_id) REFERENCES "BeneficialOwner"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "OwnerScreening" ADD CONSTRAINT "OwnerScreening_screened_by_id_fkey" FOREIGN KEY (screened_by_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "OwnershipValidation" ADD CONSTRAINT "OwnershipValidation_checked_by_id_fkey" FOREIGN KEY (checked_by_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "OwnershipValidation" ADD CONSTRAINT "OwnershipValidation_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES "Customer"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_assigned_analyst_id_fkey" FOREIGN KEY (assigned_analyst_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_assigned_reviewer_id_fkey" FOREIGN KEY (assigned_reviewer_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_created_by_id_fkey" FOREIGN KEY (created_by_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES "Customer"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_exception_id_fkey" FOREIGN KEY (exception_id) REFERENCES "Exception"(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_proposed_by_id_fkey" FOREIGN KEY (proposed_by_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_review_schedule_id_fkey" FOREIGN KEY (review_schedule_id) REFERENCES "ReviewSchedule"(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "ReviewSchedule" ADD CONSTRAINT "ReviewSchedule_completed_by_id_fkey" FOREIGN KEY (completed_by_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "ReviewSchedule" ADD CONSTRAINT "ReviewSchedule_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES "Customer"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "RiskRating" ADD CONSTRAINT "RiskRating_assessed_by_id_fkey" FOREIGN KEY (assessed_by_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "RiskRating" ADD CONSTRAINT "RiskRating_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES "Customer"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "ValidationIssue" ADD CONSTRAINT "ValidationIssue_validation_run_id_fkey" FOREIGN KEY (validation_run_id) REFERENCES "ValidationRun"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "ValidationRun" ADD CONSTRAINT "ValidationRun_created_by_id_fkey" FOREIGN KEY (created_by_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_document_id_fkey" FOREIGN KEY (document_id) REFERENCES "Document"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_reviewer_id_fkey" FOREIGN KEY (reviewer_id) REFERENCES "Reviewer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

-- Triggers
CREATE TRIGGER "Alert_business_id_immutable" BEFORE UPDATE ON public."Alert" FOR EACH ROW EXECUTE FUNCTION forbid_code_change('business_id');
CREATE TRIGGER "Alert_fill_code" BEFORE INSERT ON public."Alert" FOR EACH ROW EXECUTE FUNCTION fill_alert_business_id();
CREATE TRIGGER "Alert_guard" BEFORE UPDATE ON public."Alert" FOR EACH ROW EXECUTE FUNCTION alert_guard_update();
CREATE TRIGGER "Alert_no_delete" BEFORE DELETE ON public."Alert" FOR EACH ROW EXECUTE FUNCTION history_block_delete();
CREATE TRIGGER "AuditEvent_no_delete" BEFORE DELETE ON public."AuditEvent" FOR EACH ROW EXECUTE FUNCTION audit_event_block_delete();
CREATE TRIGGER "AuditEvent_no_truncate" BEFORE TRUNCATE ON public."AuditEvent" FOR EACH STATEMENT EXECUTE FUNCTION audit_event_block_truncate();
CREATE TRIGGER "AuditEvent_no_update" BEFORE UPDATE ON public."AuditEvent" FOR EACH ROW EXECUTE FUNCTION audit_event_block_update();
CREATE TRIGGER "BeneficialOwner_company_only" BEFORE INSERT OR UPDATE ON public."BeneficialOwner" FOR EACH ROW EXECUTE FUNCTION beneficial_owner_company_only();
CREATE TRIGGER "BeneficialOwner_mirror_insert" AFTER INSERT ON public."BeneficialOwner" FOR EACH ROW EXECUTE FUNCTION company_ownership_mirror();
CREATE TRIGGER "BeneficialOwner_mirror_update" AFTER UPDATE ON public."BeneficialOwner" FOR EACH ROW EXECUTE FUNCTION company_ownership_mirror();
CREATE TRIGGER "CaseHistory_no_delete" BEFORE DELETE ON public."CaseHistory" FOR EACH ROW EXECUTE FUNCTION history_block_delete();
CREATE TRIGGER "CaseHistory_no_update" BEFORE UPDATE ON public."CaseHistory" FOR EACH ROW EXECUTE FUNCTION history_block_update();
CREATE TRIGGER "CaseNote_no_delete" BEFORE DELETE ON public."CaseNote" FOR EACH ROW EXECUTE FUNCTION history_block_delete();
CREATE TRIGGER "CaseNote_no_update" BEFORE UPDATE ON public."CaseNote" FOR EACH ROW EXECUTE FUNCTION history_block_update();
CREATE TRIGGER "Customer_code_immutable" BEFORE UPDATE ON public."Customer" FOR EACH ROW EXECUTE FUNCTION prevent_customer_code_change();
CREATE TRIGGER "Document_code_immutable" BEFORE UPDATE ON public."Document" FOR EACH ROW EXECUTE FUNCTION forbid_code_change('business_id');
CREATE TRIGGER "Document_fill_code" BEFORE INSERT ON public."Document" FOR EACH ROW EXECUTE FUNCTION fill_document_business_id();
CREATE TRIGGER "Document_guard" BEFORE UPDATE ON public."Document" FOR EACH ROW EXECUTE FUNCTION document_guard_update();
CREATE TRIGGER "Exception_guard" BEFORE UPDATE ON public."Exception" FOR EACH ROW EXECUTE FUNCTION exception_guard_update();
CREATE TRIGGER "Exception_no_delete" BEFORE DELETE ON public."Exception" FOR EACH ROW EXECUTE FUNCTION history_block_delete();
CREATE TRIGGER "KYCRequirement_code_immutable" BEFORE UPDATE ON public."KYCRequirement" FOR EACH ROW EXECUTE FUNCTION forbid_code_change('business_id');
CREATE TRIGGER "KYCRequirement_fill_code" BEFORE INSERT ON public."KYCRequirement" FOR EACH ROW EXECUTE FUNCTION fill_requirement_business_id();
CREATE TRIGGER "OnboardingDecision_no_delete" BEFORE DELETE ON public."OnboardingDecision" FOR EACH ROW EXECUTE FUNCTION history_block_delete();
CREATE TRIGGER "OnboardingDecision_no_update" BEFORE UPDATE ON public."OnboardingDecision" FOR EACH ROW EXECUTE FUNCTION history_block_update();
CREATE TRIGGER "OnboardingDecision_reviewer_authorised" BEFORE INSERT ON public."OnboardingDecision" FOR EACH ROW EXECUTE FUNCTION onboarding_decision_check_reviewer();
CREATE TRIGGER "OwnerScreening_no_delete" BEFORE DELETE ON public."OwnerScreening" FOR EACH ROW EXECUTE FUNCTION history_block_delete();
CREATE TRIGGER "OwnerScreening_no_update" BEFORE UPDATE ON public."OwnerScreening" FOR EACH ROW EXECUTE FUNCTION history_block_update();
CREATE TRIGGER "OwnershipValidation_no_delete" BEFORE DELETE ON public."OwnershipValidation" FOR EACH ROW EXECUTE FUNCTION history_block_delete();
CREATE TRIGGER "OwnershipValidation_no_update" BEFORE UPDATE ON public."OwnershipValidation" FOR EACH ROW EXECUTE FUNCTION history_block_update();
CREATE TRIGGER "ReviewCase_fill_code" BEFORE INSERT ON public."ReviewCase" FOR EACH ROW EXECUTE FUNCTION fill_review_code();
CREATE TRIGGER "ReviewCase_guard" BEFORE UPDATE ON public."ReviewCase" FOR EACH ROW EXECUTE FUNCTION review_case_guard_update();
CREATE TRIGGER "ReviewCase_no_delete" BEFORE DELETE ON public."ReviewCase" FOR EACH ROW EXECUTE FUNCTION history_block_delete();
CREATE TRIGGER "ReviewCase_review_code_immutable" BEFORE UPDATE ON public."ReviewCase" FOR EACH ROW EXECUTE FUNCTION forbid_code_change('review_code');
CREATE TRIGGER "ReviewSchedule_guard" BEFORE UPDATE ON public."ReviewSchedule" FOR EACH ROW EXECUTE FUNCTION review_schedule_guard_update();
CREATE TRIGGER "ReviewSchedule_no_delete" BEFORE DELETE ON public."ReviewSchedule" FOR EACH ROW EXECUTE FUNCTION history_block_delete();
CREATE TRIGGER "RiskRating_no_delete" BEFORE DELETE ON public."RiskRating" FOR EACH ROW EXECUTE FUNCTION history_block_delete();
CREATE TRIGGER "RiskRating_no_update" BEFORE UPDATE ON public."RiskRating" FOR EACH ROW EXECUTE FUNCTION history_block_update();
CREATE TRIGGER "ValidationIssue_no_delete" BEFORE DELETE ON public."ValidationIssue" FOR EACH ROW EXECUTE FUNCTION history_block_delete();
CREATE TRIGGER "ValidationRun_no_delete" BEFORE DELETE ON public."ValidationRun" FOR EACH ROW EXECUTE FUNCTION history_block_delete();
CREATE TRIGGER "Verification_no_delete" BEFORE DELETE ON public."Verification" FOR EACH ROW EXECUTE FUNCTION verification_block_delete();
CREATE TRIGGER "Verification_no_update" BEFORE UPDATE ON public."Verification" FOR EACH ROW EXECUTE FUNCTION verification_block_update();
CREATE TRIGGER "Verification_reviewer_authorised" BEFORE INSERT ON public."Verification" FOR EACH ROW EXECUTE FUNCTION verification_check_reviewer();
CREATE TRIGGER "Verification_sync_status" AFTER INSERT ON public."Verification" FOR EACH ROW EXECUTE FUNCTION verification_sync_document_status();
