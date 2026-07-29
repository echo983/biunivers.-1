import { useEffect, useRef } from "react";
import {
  isTrustedHostMessage,
  parseHostRequest,
  unsupportedResponse,
} from "../hostApi/protocol";
import {
  closeHostInstance,
  createHostInstance,
} from "../hostApi/instanceClient";
import type { AppDefinition } from "../types/desktop";
import { openExternalApp } from "./openExternalApp";

interface IframeAppProps {
  app: AppDefinition;
}

export function IframeApp({ app }: IframeAppProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const instanceTokenRef = useRef<string | null>(null);
  const windowInstanceIdRef = useRef(crypto.randomUUID());
  const appOrigin = app.url ? new URL(app.url).origin : null;

  useEffect(() => {
    const abortController = new AbortController();
    void createHostInstance(
      app.id,
      windowInstanceIdRef.current,
      abortController.signal,
    )
      .then((instance) => {
        instanceTokenRef.current = instance?.instanceToken ?? null;
      })
      .catch((error: unknown) => {
        if (
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          instanceTokenRef.current = null;
        }
      });
    return () => {
      abortController.abort();
      const instanceToken = instanceTokenRef.current;
      instanceTokenRef.current = null;
      if (instanceToken) {
        void closeHostInstance(instanceToken);
      }
    };
  }, [app.id]);

  useEffect(() => {
    if (!appOrigin) {
      return;
    }

    const receiveRequest = (event: MessageEvent<unknown>) => {
      const iframeWindow = iframeRef.current?.contentWindow;
      if (!isTrustedHostMessage(event, appOrigin, iframeWindow ?? null)) {
        return;
      }

      const request = parseHostRequest(event.data);
      if (!request) {
        return;
      }

      iframeWindow?.postMessage(unsupportedResponse(request), appOrigin);
    };

    window.addEventListener("message", receiveRequest);
    return () => window.removeEventListener("message", receiveRequest);
  }, [appOrigin]);

  if (!app.url) {
    return (
      <div className="window-error" role="alert">
        应用缺少 URL，无法启动。
      </div>
    );
  }

  return (
    <div className="iframe-app">
      <div className="iframe-app__toolbar">
        <span title={app.url}>{app.name}</span>
        <button type="button" onClick={() => openExternalApp(app.url!)}>
          在新标签页打开
        </button>
      </div>
      <iframe
        ref={iframeRef}
        className="app-iframe"
        src={app.url}
        title={app.name}
      />
    </div>
  );
}
