export interface HostInstance {
  instanceToken: string;
  expiresAt: string;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export async function createHostInstance(
  appId: string,
  windowInstanceId: string,
  signal?: AbortSignal,
): Promise<HostInstance | null> {
  const response = await fetch("/api/v1/host/instances", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, windowInstanceId }),
    signal,
  });
  if (response.status === 503) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Host instance bootstrap failed: HTTP ${response.status}`);
  }
  const value = (await response.json()) as Partial<HostInstance>;
  if (
    typeof value.instanceToken !== "string" ||
    !TOKEN_PATTERN.test(value.instanceToken) ||
    typeof value.expiresAt !== "string" ||
    Number.isNaN(Date.parse(value.expiresAt))
  ) {
    throw new Error("Host instance bootstrap returned invalid data.");
  }
  return value as HostInstance;
}

export async function closeHostInstance(instanceToken: string): Promise<void> {
  if (!TOKEN_PATTERN.test(instanceToken)) {
    return;
  }
  await fetch("/api/v1/host/instances/current", {
    method: "DELETE",
    headers: {
      Authorization: `Biunivers-Instance ${instanceToken}`,
    },
    keepalive: true,
  });
}
