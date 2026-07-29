const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const pending = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();

export function queueResourceLaunch(appId: string, launchId: string): void {
  if (!TOKEN_PATTERN.test(launchId)) {
    throw new Error("Resource launch token is invalid.");
  }
  const current = pending.get(appId);
  if (current && current !== launchId) {
    throw new Error("The application already has a pending resource launch.");
  }
  if (current === launchId) return;
  pending.set(appId, launchId);
  for (const listener of listeners.get(appId) ?? []) listener();
}

export function pendingResourceLaunch(appId: string): string | undefined {
  return pending.get(appId);
}

export function consumeResourceLaunch(
  appId: string,
  launchId: string,
): void {
  if (pending.get(appId) === launchId) pending.delete(appId);
}

export function clearResourceLaunch(appId: string): void {
  pending.delete(appId);
}

export function subscribeResourceLaunch(
  appId: string,
  listener: () => void,
): () => void {
  const current = listeners.get(appId) ?? new Set();
  current.add(listener);
  listeners.set(appId, current);
  return () => {
    current.delete(listener);
    if (current.size === 0) listeners.delete(appId);
  };
}

export function resetResourceLaunchBrokerForTests(): void {
  pending.clear();
  listeners.clear();
}
