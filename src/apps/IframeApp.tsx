import { useCallback, useEffect, useRef, useState } from "react";
import {
  isTrustedHostMessage,
  parseHostRequest,
  unsupportedResponse,
} from "../hostApi/protocol";
import {
  closeHostInstance,
  createHostInstance,
} from "../hostApi/instanceClient";
import { dispatchHostRequest } from "../hostApi/dispatcher";
import { HostFilePicker } from "../hostApi/HostFilePicker";
import type { AppDefinition } from "../types/desktop";
import { openExternalApp } from "./openExternalApp";

interface IframeAppProps {
  app: AppDefinition;
}

export function IframeApp({ app }: IframeAppProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const instanceTokenRef = useRef<string | null>(null);
  const windowInstanceIdRef = useRef(crypto.randomUUID());
  const pickerResolverRef = useRef<((entryId: string | null) => void) | null>(
    null,
  );
  const [picker, setPicker] = useState<{
    instanceToken: string;
    writable: boolean;
  } | null>(null);
  const appOrigin = app.url ? new URL(app.url).origin : null;

  const selectFile = useCallback(
    (writable: boolean): Promise<string | null> => {
      const instanceToken = instanceTokenRef.current;
      if (!instanceToken || pickerResolverRef.current) {
        return Promise.resolve(null);
      }
      setPicker({ instanceToken, writable });
      return new Promise((resolve) => {
        pickerResolverRef.current = resolve;
      });
    },
    [],
  );

  const finishPicker = useCallback((entryId: string | null) => {
    const resolve = pickerResolverRef.current;
    pickerResolverRef.current = null;
    setPicker(null);
    resolve?.(entryId);
  }, []);

  useEffect(
    () => () => {
      pickerResolverRef.current?.(null);
      pickerResolverRef.current = null;
    },
    [],
  );

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

      const instanceToken = instanceTokenRef.current;
      if (!instanceToken) {
        iframeWindow?.postMessage(unsupportedResponse(request), appOrigin);
        return;
      }
      void dispatchHostRequest(request, instanceToken, { selectFile }).then(
        (response) => {
          if (iframeRef.current?.contentWindow === iframeWindow) {
            iframeWindow?.postMessage(response, appOrigin);
          }
        },
      );
    };

    window.addEventListener("message", receiveRequest);
    return () => window.removeEventListener("message", receiveRequest);
  }, [appOrigin, selectFile]);

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
      {picker ? (
        <HostFilePicker
          instanceToken={picker.instanceToken}
          writable={picker.writable}
          onSelect={finishPicker}
        />
      ) : null}
    </div>
  );
}
