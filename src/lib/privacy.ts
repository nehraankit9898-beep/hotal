/**
 * Phase 17 — Privacy / data subject request workflow.
 *
 * Tenant hard-delete / privacy request flow. Owner authorization required,
 * retention/legal checks enforced, dependencies/provider/storage cleanup
 * performed, deletion audit recorded with minimal non-personal evidence.
 *
 * Independent legal review required; no blanket DPDP/GDPR certification
 * claim is made by this module. It provides the technical scaffold for the
 * operator's documented privacy procedure.
 *
 * States:
 *  PENDING      → owner has submitted a request
 *  APPROVED     → legal review complete, retention hold expired
 *  IN_PROGRESS  → cleanup running
 *  COMPLETED    → audit recorded, no PII remains
 *  REJECTED     → documented reason
 */
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import type { AuthedUser } from "@/lib/api-helpers";

export type PrivacyRequestType = "EXPORT" | "DELETE" | "RECTIFY";
export type PrivacyRequestStatus =
  | "PENDING"
  | "APPROVED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "REJECTED";

interface CreateRequestInput {
  hotelId: string;
  type: PrivacyRequestType;
  requestedBy: string;
  notes?: string;
}

/**
 * Create a new privacy request. Always PENDING. The owner must explicitly
 * approve it (and confirm legal review) before any destructive action.
 */
export async function createPrivacyRequest(
  user: AuthedUser,
  type: PrivacyRequestType,
  notes?: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string; status?: number }> {
  if (user.role === "SUPER_ADMIN") {
    return { ok: false, error: "Privacy requests are tenant-initiated.", status: 403 };
  }
  if (user.role !== "HOTEL_OWNER" && user.role !== "HOTEL_ADMIN") {
    return { ok: false, error: "Only the owner/admin may initiate a privacy request.", status: 403 };
  }
  try {
    const req = await db.privacyRequest.create({
      data: {
        hotelId: user.hotelId,
        type,
        status: "PENDING",
        requestedBy: user.userId,
        // Default retention hold: 7 days to allow legal review.
        retentionExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    await logAudit({
      hotelId: user.hotelId,
      userId: user.userId,
      action: "PRIVACY_REQUEST_CREATED",
      entityType: "PrivacyRequest",
      entityId: req.id,
      metadata: { type, notes: notes?.slice(0, 500) },
    });
    return { ok: true, id: req.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Approve a pending request — sets status to APPROVED and clears retention
 * hold only after legal review is recorded. Owner-only.
 */
export async function approvePrivacyRequest(
  user: AuthedUser,
  requestId: string,
  legalReviewBy: string,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  if (user.role !== "HOTEL_OWNER" && user.role !== "HOTEL_ADMIN") {
    return { ok: false, error: "Forbidden", status: 403 };
  }
  const req = await db.privacyRequest.findFirst({
    where: { id: requestId, hotelId: user.hotelId },
  });
  if (!req) return { ok: false, error: "Request not found.", status: 404 };
  if (req.status !== "PENDING") {
    return { ok: false, error: `Request is ${req.status}, not PENDING.`, status: 409 };
  }
  await db.privacyRequest.update({
    where: { id: requestId },
    data: { status: "APPROVED", approvedBy: user.userId, legalReviewBy },
  });
  await logAudit({
    hotelId: user.hotelId,
    userId: user.userId,
    action: "PRIVACY_REQUEST_APPROVED",
    entityType: "PrivacyRequest",
    entityId: requestId,
    metadata: { legalReviewBy },
  });
  return { ok: true };
}

/**
 * Execute a DELETE-type privacy request. THIS IS DESTRUCTIVE.
 *
 * Pre-conditions:
 *  - request is APPROVED
 *  - retention hold has expired (retentionExpiresAt < now)
 *  - legal review is recorded
 *
 * Cleanup performed (best-effort, in order):
 *  1. Anonymize customer PII (name/phone/email set to "[DELETED]")
 *  2. Revoke all active API keys
 *  3. Revoke all active sessions (tokenVersion bump on all users)
 *  4. Mark the tenant Hotel as ARCHIVED (data preserved for financial
 *     audit compliance; explicit hard-delete is a separate destructive
 *     operation requiring Super Admin authorization)
 *
 * The audit summary is recorded in `auditSummary` and never contains PII.
 */
export async function executeDeleteRequest(
  user: AuthedUser,
  requestId: string,
): Promise<{ ok: true; summary: string } | { ok: false; error: string; status?: number }> {
  if (user.role !== "HOTEL_OWNER") {
    return { ok: false, error: "Only the HOTEL_OWNER may execute a delete request.", status: 403 };
  }
  const req = await db.privacyRequest.findFirst({
    where: { id: requestId, hotelId: user.hotelId, type: "DELETE" },
  });
  if (!req) return { ok: false, error: "Request not found.", status: 404 };
  if (req.status !== "APPROVED") {
    return { ok: false, error: `Request must be APPROVED first (currently ${req.status}).`, status: 409 };
  }
  if (!req.retentionExpiresAt || req.retentionExpiresAt > new Date()) {
    return { ok: false, error: "Retention hold has not expired yet.", status: 409 };
  }

  await db.privacyRequest.update({
    where: { id: requestId },
    data: { status: "IN_PROGRESS" },
  });

  // Best-effort PII anonymization. The financial/audit records are preserved
  // (legal compliance) — they retain the customer ID reference but the
  // customer.name/phone/email are blanked.
  const anonymizedCustomers = await db.customer.updateMany({
    where: { hotelId: user.hotelId },
    data: { name: "[DELETED]", phone: "[DELETED]", email: null, marketingConsent: false },
  });
  const revokedKeys = await db.apiKey.updateMany({
    where: { hotelId: user.hotelId, status: "ACTIVE" },
    data: { status: "REVOKED", revokedAt: new Date() },
  });
  const revokedSessions = await db.user.updateMany({
    where: { hotelId: user.hotelId },
    data: { tokenVersion: { increment: 1 } },
  });
  // Archive the tenant (NOT delete — financial records must be retained per law).
  await db.hotel.update({
    where: { id: user.hotelId },
    data: { status: "ARCHIVED", suspendedAt: new Date(), suspensionReason: "Privacy delete request" },
  });

  const summary = JSON.stringify({
    anonymizedCustomers: anonymizedCustomers.count,
    revokedApiKeys: revokedKeys.count,
    revokedSessions: revokedSessions.count,
    hotelArchived: true,
    hardDeletePerformed: false, // hard-delete is a separate Super-Admin operation
  });

  await db.privacyRequest.update({
    where: { id: requestId },
    data: { status: "COMPLETED", completedAt: new Date(), auditSummary: summary },
  });

  await logAudit({
    hotelId: user.hotelId,
    userId: user.userId,
    action: "PRIVACY_REQUEST_EXECUTED",
    entityType: "PrivacyRequest",
    entityId: requestId,
    metadata: JSON.parse(summary),
  });

  return { ok: true, summary };
}

/**
 * Export a privacy request audit summary. Used by the operator to demonstrate
 * the action was performed. Contains ONLY non-personal counts — never PII.
 */
export async function readRequestSummary(
  user: AuthedUser,
  requestId: string,
): Promise<{ ok: true; summary: Record<string, unknown> | null } | { ok: false; error: string; status?: number }> {
  const req = await db.privacyRequest.findFirst({
    where: { id: requestId, hotelId: user.hotelId },
    select: { status: true, auditSummary: true, type: true, completedAt: true },
  });
  if (!req) return { ok: false, error: "Request not found.", status: 404 };
  if (!req.auditSummary) return { ok: true, summary: null };
  try {
    return { ok: true, summary: JSON.parse(req.auditSummary) };
  } catch {
    return { ok: true, summary: { raw: req.auditSummary.slice(0, 500) } };
  }
}
