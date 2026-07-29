interface DirectoryLaunch {
  entryId: string;
  name: string;
}

let pendingDirectory: DirectoryLaunch | undefined;
const listeners = new Set<() => void>();

export function queueDirectoryLaunch(entryId: string, name: string) {
  pendingDirectory = { entryId, name };
  listeners.forEach((listener) => listener());
}

export function consumeDirectoryLaunch() {
  const launch = pendingDirectory;
  pendingDirectory = undefined;
  return launch;
}

export function resetDirectoryLaunchBrokerForTests() {
  pendingDirectory = undefined;
  listeners.clear();
}

export function subscribeDirectoryLaunch(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
