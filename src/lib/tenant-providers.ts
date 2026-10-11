import { db } from "@/lib/db";
import { decryptCredentials, isEncryptedEnvelope } from "@/lib/crypto";
import {
  getProvider,
  WhatsAppCloudProvider,
  TwilioSmsProvider,
  SimulationProvider,
  type Channel,
  type MessageProvider,
  type SendResult,
} from "@/lib/providers";

/**
 * AUDIT FIX (F04) — TENANT-SCOPED provider resolution.
 * RECHECK FIX (F) — EXPLICIT provider-source policy (fail closed).
 *
 * Two connected problems this fixes:
 *
 * 1. `getProvider()` (providers/index.ts) only reads GLOBAL environment
 *    variables. A restaurant that saved its own WhatsApp credentials in the
 *    Integration vault still sent through whatever the platform ENV had (or
 *    silently through SIMULATION) — the saved key was decoration.
 *
 * 2. Disabling or deleting an integration in the UI only flipped a database
 *    row — actual runtime sends kept using ENV credentials. The recheck
 *    probe proved it: a DISABLED tenant WhatsApp integration + platform ENV
 *    credentials → the send still selected the platform phone endpoint.
 *
 * The policy is now EXPLICIT (never implicit ENV fallback while a tenant row
 * exists for the channel):
 *
 *   - Tenant integration rows exist for the channel:
 *       · an ENABLED + VERIFIED/CONNECTED row with decryptable, complete
 *         credentials → the TENANT provider is used;
 *       · otherwise (all rows disabled / unverified / undecryptable /
 *         incomplete) sends are BLOCKED — a provider whose send() always
 *         fails with the honest reason. The tenant's own broken state never
 *         silently falls through to the platform's shared sender, and an
 *         unreadable vault entry fails closed instead of pretending.
 *   - No tenant rows at all → the merchant has not configured their own
 *     sender: platform ENV credentials are used (self-host convenience),
 *     then SIMULATION.
 *
 * Disabled integrations therefore GENUINELY stop sends (matching the UI
 * promise "Disabled integrations are skipped by campaigns") instead of
 * rerouting them through the platform.
 */

interface TenantResolution {
  policy: "TENANT" | "BLOCKED" | "NO_TENANT_CONFIG";
  provider: MessageProvider | null;
  reason?: string;
}

/**
 * A provider that refuses to send. Used when the tenant has integration rows
 * for the channel but none of them is usable — live sends must be blocked,
 * never silently rerouted to the platform sender or disguised as simulation.
 */
class BlockedProvider implements MessageProvider {
  readonly id = "BLOCKED";
  readonly channel: Channel;

  constructor(
    private readonly channelBlocked: Channel,
    private readonly reason: string,
  ) {
    void this.channelBlocked;
    this.channel = channelBlocked;
  }

  async send(_msg: { to: string; body: string }): Promise<SendResult> {
    void _msg;
    return {
      ok: false,
      provider: this.id,
      error: this.reason,
    };
  }
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

async function resolveTenantChannel(hotelId: string, channel: Channel): Promise<TenantResolution> {
  const expectedTypes: Record<Channel, string[]> = {
    WHATSAPP: ["WHATSAPP_CLOUD"],
    SMS: ["TWILIO_SMS"],
    EMAIL: ["SMTP"],
  };

  // RECHECK FIX (F): load EVERY row for the channel (any status/enabled) —
  // existence of a tenant row switches the policy from "platform default"
  // to "tenant-owned, fail closed". Rows WITHOUT any credentials are empty
  // placeholders (e.g. the seeded catalog) — they never owned the channel,
  // so they don't block; rows WITH credentials that are disabled/unverified/
  // undecryptable DO block (the tenant owns the channel and its state is
  // broken — never silently reroute through the platform sender).
  const rows = await db.integration.findMany({
    where: {
      hotelId,
      type: { in: expectedTypes[channel] as never[] },
    },
    orderBy: { updatedAt: "desc" },
  });

  const usable = rows.filter(
    (r) =>
      r.enabled &&
      r.credentials &&
      isEncryptedEnvelope(r.credentials) &&
      (r.status === "VERIFIED" || r.status === "CONNECTED"),
  );
  const credentialed = rows.filter((r) => r.credentials && isEncryptedEnvelope(r.credentials));

  if (rows.length === 0 || (usable.length === 0 && credentialed.length === 0)) {
    return { policy: "NO_TENANT_CONFIG", provider: null };
  }

  // Best usable row: enabled + VERIFIED/CONNECTED (legacy rows pre-dating
  // F04 keep working) + credentials present and decryptable.
  for (const row of rows) {
    if (!row.enabled || !row.credentials || !isEncryptedEnvelope(row.credentials)) continue;
    if (row.status !== "VERIFIED" && row.status !== "CONNECTED") continue;

    let creds: Record<string, unknown>;
    try {
      creds = decryptCredentials({ hotelId, integrationType: row.type }, row.credentials) as Record<
        string,
        unknown
      >;
    } catch {
      // Vault row cannot be decrypted (key rotation loss, tampering) —
      // keep looking at other rows; if none works the channel is BLOCKED,
      // never an implicit ENV fallback.
      continue;
    }

    if (channel === "WHATSAPP") {
      const token = asString(creds.token ?? creds.accessToken);
      const phoneNumberId = asString(creds.phoneNumberId ?? creds.phone_number_id);
      if (token && phoneNumberId) {
        return { policy: "TENANT", provider: new WhatsAppCloudProvider(token, phoneNumberId) };
      }
      continue;
    }
    if (channel === "SMS") {
      const sid = asString(creds.accountSid ?? creds.account_sid);
      const token = asString(creds.authToken ?? creds.auth_token);
      const from = asString(creds.fromNumber ?? creds.from_number);
      if (sid && token && from) {
        return { policy: "TENANT", provider: new TwilioSmsProvider(sid, token, from) };
      }
      continue;
    }
    // EMAIL: tenant SMTP rows are not yet wired to the EmailService transport
    // (platform-level email config remains authoritative). No tenant override.
    continue;
  }

  // Rows exist and at least one holds credentials, but NONE is usable —
  // explain honestly which state blocked it (fail closed).
  const disabled = credentialed.filter((r) => !r.enabled).length;
  const unverified = credentialed.filter(
    (r) => r.enabled && r.status !== "VERIFIED" && r.status !== "CONNECTED",
  ).length;
  const reason =
    disabled === credentialed.length
      ? `The venue's ${channel} integration is disabled — enable and verify it (or delete it) before messages can be sent.`
      : unverified === credentialed.length
        ? `The venue's ${channel} integration is saved but not verified — run "Verify connection" on the Integrations page before messages can be sent.`
        : `The venue's ${channel} integration is not usable (unreadable or incomplete credentials) — messages are blocked until it is re-saved and verified.`;
  return { policy: "BLOCKED", provider: new BlockedProvider(channel, reason), reason };
}

/**
 * Resolve the provider to use for a send on behalf of a hotel.
 * Never throws. Policy (recheck fix F):
 *   TENANT (usable row) → tenant provider
 *   BLOCKED (rows exist, none usable) → BlockedProvider (send fails honestly)
 *   NO_TENANT_CONFIG → platform ENV → SIMULATION
 */
export async function resolveTenantProvider(
  hotelId: string | null | undefined,
  channel: Channel,
): Promise<MessageProvider> {
  if (hotelId) {
    try {
      const tenant = await resolveTenantChannel(hotelId, channel);
      if (tenant.policy === "TENANT" && tenant.provider) return tenant.provider;
      if (tenant.policy === "BLOCKED" && tenant.provider) return tenant.provider;
    } catch {
      // Vault lookup infrastructure failure — fail closed rather than
      // silently routing tenant traffic through platform credentials.
      return new BlockedProvider(
        channel,
        `The venue's ${channel} integration state could not be checked — sending is blocked for safety.`,
      );
    }
  }
  const envProvider = getProvider(channel);
  if (envProvider.id !== "SIMULATION") return envProvider;
  return new SimulationProvider(channel);
}

/** Which source will this hotel's channel actually send through? (UI honesty) */
export async function describeTenantSendPath(
  hotelId: string,
  channel: Channel,
): Promise<{ source: string; providerId: string; reason?: string }> {
  try {
    const tenant = await resolveTenantChannel(hotelId, channel);
    if (tenant.policy === "TENANT" && tenant.provider) {
      return { source: "TENANT", providerId: tenant.provider.id };
    }
    if (tenant.policy === "BLOCKED") {
      return { source: "BLOCKED", providerId: "BLOCKED", reason: tenant.reason };
    }
  } catch {
    return {
      source: "BLOCKED",
      providerId: "BLOCKED",
      reason: "Integration state could not be checked.",
    };
  }
  const provider = getProvider(channel);
  if (provider.id === "SIMULATION") return { source: "SIMULATION", providerId: "SIMULATION" };
  return { source: "PLATFORM_ENV", providerId: provider.id };
}
