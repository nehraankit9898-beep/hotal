# Payment and financial audit — 2026-10-12 addendum

Earlier static unit inventory: `audit/DATABASE_AND_MIGRATION_AUDIT.md` and `audit/SECURITY_FINDINGS.md`. Restaurant bill paths (`src/lib/billing.ts`) generally use integer `*Minor`; older SaaS `Payment.amount`, coupons and related fields are `Float` with mixed units. **Do not convert existing data blindly.** No provider sandbox credentials or disposable DB engine: signature verification, webhook processing, rounding/refunds/reconciliation not executed. Status **BLOCKED/NOT TESTED**.

- SEC-007: public link GET/checkout/verify (`src/app/api/pay/[token]/*`) now uses `src/lib/payment-link-limit.ts`. Checkout 10/IP/min; read 60, verify 30; unit in-process fallback PASS (1 test). Distributed Redis mode NOT TESTED.
- PAY-001: `src/app/api/pay/[token]/verify/route.ts` swallows failure updating link after capture. Remaining High risk; source inspection only, must reconcile transactionally and test idempotent recovery before real payments.
- Existing client-controlled amount guard is in `checkout/route.ts` (uses `link.amountMinor`); source inspected, not externally verified. Provider credentials, callback signatures and currencies **BLOCKED**. No real payment was attempted.
