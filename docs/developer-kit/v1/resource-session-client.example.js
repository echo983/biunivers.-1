const protocol = "biunivers.resource-session/1";
const pending = new Map();
const hostOrigin = new URL(document.referrer).origin;

window.addEventListener("message", (event) => {
  if (
    event.source !== window.parent ||
    event.origin !== hostOrigin ||
    event.data?.protocol !== protocol
  ) return;
  if (event.data.event === "launch.contextAvailable") {
    void claimLaunch();
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

export async function claimLaunch() {
  const context = await call("resource.claimLaunch");
  return useSession(context.resource);
}

export async function chooseFile(access = "read") {
  return useSession(await call("resource.open", { access }));
}

function useSession(session) {
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
