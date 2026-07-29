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
import { HostSaveDialog } from "../hostApi/HostSaveDialog";
import type { AppDefinition } from "../types/desktop";
import { openExternalApp } from "./openExternalApp";

interface IframeAppProps {
  app: AppDefinition;
}

export function IframeApp({ app }: IframeAppProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const instanceTokenRef = useRef<string | null>(null);
  const instanceReadyRef = useRef<Promise<string | null>>(
    Promise.resolve(null),
  );
  const windowInstanceIdRef = useRef(crypto.randomUUID());
  const pickerResolverRef = useRef<((entryId: string | null) => void) | null>(
    null,
  );
  const saveResolverRef = useRef<
    ((target: { parentEntryId: string; name: string } | null) => void) | null
  >(null);
  const [picker, setPicker] = useState<{
    instanceToken: string;
    writable: boolean;
  } | null>(null);
  const [saveDialog, setSaveDialog] = useState<{
    instanceToken: string;
    suggestedName: string;
  } | null>(null);
  const appOrigin = app.url ? new URL(app.url).origin : null;

  const selectFile = useCallback(
    (writable: boolean): Promise<string | null> => {
      const instanceToken = instanceTokenRef.current;
      if (
        !instanceToken ||
        pickerResolverRef.current ||
        saveResolverRef.current
      ) {
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

  const selectSaveTarget = useCallback(
    (
      suggestedName: string,
    ): Promise<{ parentEntryId: string; name: string } | null> => {
      const instanceToken = instanceTokenRef.current;
      if (
        !instanceToken ||
        pickerResolverRef.current ||
        saveResolverRef.current
      ) {
        return Promise.resolve(null);
      }
      setSaveDialog({ instanceToken, suggestedName });
      return new Promise((resolve) => {
        saveResolverRef.current = resolve;
      });
    },
    [],
  );

  const finishSaveDialog = useCallback(
    (target: { parentEntryId: string; name: string } | null) => {
      const resolve = saveResolverRef.current;
      saveResolverRef.current = null;
      setSaveDialog(null);
      resolve?.(target);
    },
    [],
  );

  useEffect(
    () => () => {
      pickerResolverRef.current?.(null);
      pickerResolverRef.current = null;
      saveResolverRef.current?.(null);
      saveResolverRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const abortController = new AbortController();
    const instanceReady = createHostInstance(
      app.id,
      windowInstanceIdRef.current,
      abortController.signal,
    )
      .then((instance) => {
        instanceTokenRef.current = instance?.instanceToken ?? null;
        return instanceTokenRef.current;
      })
      .catch((error: unknown) => {
        if (
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          instanceTokenRef.current = null;
        }
        return null;
      });
    instanceReadyRef.current = instanceReady;
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

      void instanceReadyRef.current.then(async (instanceToken) => {
        const response = instanceToken
          ? await dispatchHostRequest(request, instanceToken, {
              selectFile,
              selectSaveTarget,
            })
          : unsupportedResponse(request);
        if (iframeRef.current?.contentWindow === iframeWindow) {
          iframeWindow?.postMessage(response, appOrigin);
        }
      });
    };

    window.addEventListener("message", receiveRequest);
    return () => window.removeEventListener("message", receiveRequest);
  }, [appOrigin, selectFile, selectSaveTarget]);

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
      {saveDialog ? (
        <HostSaveDialog
          instanceToken={saveDialog.instanceToken}
          suggestedName={saveDialog.suggestedName}
          onFinish={finishSaveDialog}
        />
      ) : null}
    </div>
  );
}
