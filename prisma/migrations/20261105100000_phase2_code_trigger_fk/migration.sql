-- Follow-up to 20261105090000: when the customer does not exist, report the foreign-key violation (the real problem)
-- instead of failing later on the empty business code.
CREATE OR REPLACE FUNCTION fill_document_business_id() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fill_review_code() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;
