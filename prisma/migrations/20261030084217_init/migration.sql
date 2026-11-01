-- CreateTable
CREATE TABLE "CustomerType" (
    "id" SERIAL NOT NULL,
    "type_name" TEXT NOT NULL,

    CONSTRAINT "CustomerType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" SERIAL NOT NULL,
    "customer_id" TEXT NOT NULL,
    "customer_type_id" INTEGER NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "pan_number" TEXT NOT NULL,
    "aadhaar_number" TEXT,
    "pan_hash" TEXT NOT NULL,
    "aadhaar_hash" TEXT,
    "date_of_birth" DATE,
    "occupation" TEXT,
    "company_registration_number" TEXT,
    "business_activity" TEXT,
    "date_of_incorporation" DATE,
    "registration_status" TEXT NOT NULL DEFAULT 'Registered',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskRating" (
    "id" SERIAL NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "risk_score" INTEGER NOT NULL,
    "risk_level" TEXT NOT NULL,
    "risk_reasons" JSONB NOT NULL,
    "assessment_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assessment_method" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskRating_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerType_type_name_key" ON "CustomerType"("type_name");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_customer_id_key" ON "Customer"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_pan_hash_key" ON "Customer"("pan_hash");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_aadhaar_hash_key" ON "Customer"("aadhaar_hash");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_company_registration_number_key" ON "Customer"("company_registration_number");

-- CreateIndex
CREATE INDEX "Customer_customer_type_id_idx" ON "Customer"("customer_type_id");

-- CreateIndex
CREATE INDEX "Customer_full_name_idx" ON "Customer"("full_name");

-- CreateIndex
CREATE INDEX "Customer_created_at_idx" ON "Customer"("created_at");

-- CreateIndex
CREATE INDEX "RiskRating_customer_id_assessment_date_idx" ON "RiskRating"("customer_id", "assessment_date");

-- CreateIndex
CREATE INDEX "RiskRating_risk_level_idx" ON "RiskRating"("risk_level");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_customer_type_id_fkey" FOREIGN KEY ("customer_type_id") REFERENCES "CustomerType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskRating" ADD CONSTRAINT "RiskRating_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written additions (Prisma cannot express these)
-- ===========================================================================

-- Reference data: the two customer types. Fixed ids 1 and 2 are relied on by the CHECK
-- constraint further below.
INSERT INTO "CustomerType" ("id", "type_name") VALUES (1, 'Individual'), (2, 'Company');
SELECT setval(pg_get_serial_sequence('"CustomerType"', 'id'), 2);

ALTER TABLE "CustomerType"
  ADD CONSTRAINT "CustomerType_name_check" CHECK ("type_name" IN ('Individual', 'Company'));

-- Customer ID generation -------------------------------------------------------------
-- A PostgreSQL sequence is concurrency-safe: two simultaneous registrations can never
-- receive the same number, and a number is never handed out twice - even if the customer
-- row is later deleted or the transaction rolls back (gaps are possible, reuse is not).
CREATE SEQUENCE "customer_code_seq" START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE FUNCTION next_customer_code() RETURNS TEXT AS $$
  SELECT 'CUS-' || lpad(nextval('customer_code_seq')::text, 6, '0');
$$ LANGUAGE sql;

-- Customer ID is immutable once written.
CREATE FUNCTION prevent_customer_code_change() RETURNS trigger AS $$
BEGIN
  IF NEW."customer_id" IS DISTINCT FROM OLD."customer_id" THEN
    RAISE EXCEPTION 'customer_id is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Customer_code_immutable"
  BEFORE UPDATE ON "Customer"
  FOR EACH ROW EXECUTE FUNCTION prevent_customer_code_change();

-- Customer constraints -----------------------------------------------------------------
ALTER TABLE "Customer"
  ADD CONSTRAINT "Customer_code_format_check" CHECK ("customer_id" ~ '^CUS-[0-9]{6,}$'),
  ADD CONSTRAINT "Customer_status_check" CHECK ("registration_status" IN ('Registered', 'Pending Review', 'Closed')),
  ADD CONSTRAINT "Customer_name_not_blank_check" CHECK (length(btrim("full_name")) > 0),
  -- Individuals (type 1) need DOB + Aadhaar and must not carry company fields;
  -- Companies (type 2) need registration number, activity, incorporation date and must not carry personal fields.
  ADD CONSTRAINT "Customer_type_fields_check" CHECK (
    ("customer_type_id" = 1
       AND "date_of_birth" IS NOT NULL
       AND "aadhaar_number" IS NOT NULL AND "aadhaar_hash" IS NOT NULL
       AND "company_registration_number" IS NULL
       AND "business_activity" IS NULL
       AND "date_of_incorporation" IS NULL)
    OR
    ("customer_type_id" = 2
       AND "company_registration_number" IS NOT NULL
       AND "business_activity" IS NOT NULL
       AND "date_of_incorporation" IS NOT NULL
       AND "date_of_birth" IS NULL
       AND "aadhaar_number" IS NULL AND "aadhaar_hash" IS NULL)
  );

-- RiskRating constraints ------------------------------------------------------------
ALTER TABLE "RiskRating"
  ADD CONSTRAINT "RiskRating_level_check" CHECK ("risk_level" IN ('Low', 'Medium', 'High')),
  ADD CONSTRAINT "RiskRating_score_check" CHECK ("risk_score" BETWEEN 0 AND 100);
