/** Stack keys: `<repoKey>.<serviceId>` for a service, `<repoKey>.<serviceId>.<listen>` for one of its ports. */
export const serviceKey = (repoKey: string, serviceId: string): string => `${repoKey}.${serviceId}`;

export const listenKey = (repoKey: string, serviceId: string, listen: string): string => `${repoKey}.${serviceId}.${listen}`;

/** Inverse of both; repo keys and service ids never contain dots, a listen name may. */
export function parseKey(key: string): { repoKey: string; serviceId: string; listen?: string } | undefined {
  const parts = key.split(".");
  if (parts.length < 2 || parts[0] === "" || parts[1] === "") return undefined;
  const listen = parts.slice(2).join(".");
  return { repoKey: parts[0] as string, serviceId: parts[1] as string, ...(listen !== "" ? { listen } : {}) };
}
