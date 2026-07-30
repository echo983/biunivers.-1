export interface WormholeStatus {
  enabled: boolean;
  username?: string;
  password?: string;
  path?: string;
  enabledAt?: string;
}

export function getWormholeStatus(instanceToken: string) {
  return request("/api/v1/internal/wormhole", instanceToken);
}

export function enableWormhole(instanceToken: string) {
  return request("/api/v1/internal/wormhole/enable", instanceToken, "POST");
}

export function rotateWormhole(instanceToken: string) {
  return request("/api/v1/internal/wormhole/rotate", instanceToken, "POST");
}

export function disableWormhole(instanceToken: string) {
  return request("/api/v1/internal/wormhole", instanceToken, "DELETE");
}

async function request(
  path: string,
  instanceToken: string,
  method = "GET",
): Promise<WormholeStatus> {
  const response = await fetch(path, {
    method,
    headers: { Authorization: `Biunivers-Instance ${instanceToken}` },
  });
  const value = await response.json();
  if (!response.ok) {
    throw new Error(
      value?.error?.message ?? `Wormhole request failed: HTTP ${response.status}`,
    );
  }
  return value as WormholeStatus;
}
