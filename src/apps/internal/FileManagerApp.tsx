import { useEffect, useState } from "react";
import {
  closeHostInstance,
  createHostInstance,
} from "../../hostApi/instanceClient";

type FileManagerStatus =
  | { mode: "loading" }
  | { mode: "unavailable" }
  | { mode: "error"; message: string }
  | { mode: "ready"; instanceToken: string };

export function FileManagerApp() {
  const [status, setStatus] = useState<FileManagerStatus>({
    mode: "loading",
  });

  useEffect(() => {
    const controller = new AbortController();
    let instanceToken: string | undefined;

    void createHostInstance(
      "system.files",
      crypto.randomUUID(),
      controller.signal,
    )
      .then((instance) => {
        if (controller.signal.aborted) {
          if (instance) {
            void closeHostInstance(instance.instanceToken);
          }
          return;
        }
        if (!instance) {
          setStatus({ mode: "unavailable" });
          return;
        }
        instanceToken = instance.instanceToken;
        setStatus({
          mode: "ready",
          instanceToken: instance.instanceToken,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStatus({
          mode: "error",
          message:
            error instanceof Error
              ? error.message
              : "文件管理器初始化失败",
        });
      });

    return () => {
      controller.abort();
      if (instanceToken) {
        void closeHostInstance(instanceToken);
      }
    };
  }, []);

  if (status.mode === "loading") {
    return <div className="window-loading">正在连接文件服务…</div>;
  }
  if (status.mode === "unavailable") {
    return (
      <div className="window-error" role="status">
        当前宿主尚未启用文件能力。
      </div>
    );
  }
  if (status.mode === "error") {
    return (
      <div className="window-error" role="alert">
        {status.message}
      </div>
    );
  }
  return (
    <article className="file-manager-app">
      <header>
        <h1>文件</h1>
        <p>文件服务已就绪。目录管理将在下一施工阶段接入。</p>
      </header>
    </article>
  );
}
