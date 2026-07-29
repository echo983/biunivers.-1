const protocol = "biunivers.host-api/1";
const pending = new Map();

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) {
    return;
  }
  const message = event.data;
  if (
    !message ||
    message.protocol !== protocol ||
    typeof message.requestId !== "string"
  ) {
    return;
  }
  const request = pending.get(message.requestId);
  if (!request) {
    return;
  }
  pending.delete(message.requestId);
  if (message.ok) {
    request.resolve(message.result);
  } else {
    const error = new Error(message.error?.message || "Host API 请求失败");
    error.code = message.error?.code || "HOST_API_FAILED";
    request.reject(error);
  }
});

export function hostRequest(method, params) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    window.parent.postMessage(
      { protocol, requestId, method, params },
      "*",
    );
  });
}

export async function readTransfer(transfer) {
  const response = await fetch(transfer.url, {
    headers: {
      Authorization: `${transfer.authorization} ${transfer.instanceToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(`读取失败：HTTP ${response.status}`);
  }
  return await response.text();
}

export async function writeTransfer(transfer, text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > transfer.maxBytes) {
    throw new Error(`内容超过 ${transfer.maxBytes} 字节上限`);
  }
  const response = await fetch(transfer.url, {
    method: "PUT",
    headers: {
      Authorization: `${transfer.authorization} ${transfer.instanceToken}`,
      "Content-Type": "application/octet-stream",
    },
    body: bytes,
  });
  if (!response.ok) {
    throw new Error(`保存失败：HTTP ${response.status}`);
  }
  return await response.json();
}
