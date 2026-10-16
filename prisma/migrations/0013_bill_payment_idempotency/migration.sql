-- Durable idempotency fence for manual bill-payment retries.
-- Nullable so existing and gateway-created payments remain unaffected.
ALTER TABLE "BillPayment" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "BillPayment_idempotencyKey_key" ON "BillPayment"("idempotencyKey");
