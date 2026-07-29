let pendingDirectoryEntryId: string | undefined;
const listeners = new Set<() => void>();

export function queueDirectoryLaunch(entryId: string) {
  pendingDirectoryEntryId = entryId;
  listeners.forEach((listener) => listener());
}

export function consumeDirectoryLaunch() {
  const entryId = pendingDirectoryEntryId;
  pendingDirectoryEntryId = undefined;
  return entryId;
}

export function subscribeDirectoryLaunch(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
