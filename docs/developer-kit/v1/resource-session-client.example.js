const protocol = "biunivers.resource-session/1";
const pending = new Map();
const launchListeners = new Set();
const hostOrigin = new URL(document.referrer).origin;

window.addEventListener("message", (event) => {
  if (
    event.source !== window.parent ||
    event.origin !== hostOrigin ||
    event.data?.protocol !== protocol
  ) return;
  if (event.data.event === "launch.contextAvailable") {
    for (const listener of launchListeners) listener();
    return;
  }
  const request = pending.get(event.data.requestId);
  if (!request) return;
  pending.delete(event.data.requestId);
  event.data.ok
    ? request.resolve(event.data.result)
    : request.reject(
        Object.assign(new Error(event.data.error?.message ?? "请求失败"), {
          code: event.data.error?.code,
        }),
      );
});

function call(method, params = {}) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    window.parent.postMessage(
      { protocol, requestId, method, params },
      hostOrigin,
    );
  });
}

export function getCapabilities() {
  return call("resource.getCapabilities");
}

export async function claimLaunch() {
  const context = await call("resource.claimLaunch");
  return context.resources
    ? {
        action: context.action,
        resources: context.resources.map(useSession),
      }
    : {
        action: context.action,
        resource: useSession(context.resource),
      };
}

export async function chooseFile(access = "read") {
  return useSession(await call("resource.open", { access }));
}

export async function chooseFiles(maximum = 100) {
  const capabilities = await getCapabilities();
  if (!capabilities.openMany) {
    throw new Error("当前宿主或应用声明未启用多资源能力");
  }
  const result = await call("resource.openMany", {
    access: "read",
    maximum,
  });
  return result.resources.map(useSession);
}

export async function saveAs(suggestedName) {
  return useSession(await call("resource.saveAs", { suggestedName }));
}

export function onLaunchAvailable(listener) {
  launchListeners.add(listener);
  return () => launchListeners.delete(listener);
}

export function useSession(session) {
  const headers = {
    Authorization: `${session.content.authorization} ${session.content.instanceToken}`,
    [session.content.sessionHeader]: session.sessionId,
  };
  return {
    session,
    read: (range) =>
      fetch(session.content.url, {
        headers: { ...headers, ...(range ? { Range: range } : {}) },
      }),
    save: (bytes) =>
      fetch(session.content.url, { method: "PUT", headers, body: bytes }),
    renew: () =>
      call("resource.renew", { sessionIds: [session.sessionId] }),
    release: () =>
      call("resource.release", { sessionIds: [session.sessionId] }),
  };
}

export function renewSessions(resources) {
  return call("resource.renew", {
    sessionIds: resources.map((resource) => resource.session.sessionId),
  });
}

export function releaseSessions(resources) {
  return call("resource.release", {
    sessionIds: resources.map((resource) => resource.session.sessionId),
  });
}
