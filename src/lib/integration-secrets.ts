import { db } from "@/lib/db";
import { decryptCredentials } from "@/lib/crypto";

/**
 * SERVER-SIDE ONLY helper for integration clients: decrypt stored credentials
 * for use in provider calls. NEVER import this into code that returns its
 * result to a client, and NEVER log its output.
 */
export async function getIntegrationSecrets(
  integrationId: string,
  hotelId: string,
): Promise<Record<string, unknown> | null> {
  const integration = await db.integration.findFirst({ where: { id: integrationId, hotelId } });
  if (!integration?.credentials) return null;
  return decryptCredentials(
    { hotelId, integrationType: integration.type },
    integration.credentials,
  );
}
