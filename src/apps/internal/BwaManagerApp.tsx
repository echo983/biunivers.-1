import { useMemo, useState, type FormEvent } from "react";
import {
  BwaManagerClient,
  type BwaApplicationSummary,
  type BwaInstanceSummary,
} from "../../api/bwaManagerClient";
import { useDesktopStore } from "../../store/desktopStore";
import { openApp } from "../../windows/windowController";

export function BwaManagerApp() {
  const [tokenInput, setTokenInput] = useState("");
  const [token, setToken] = useState<string>();
  const [applications, setApplications] = useState<BwaApplicationSummary[]>([]);
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const registerRuntimeApp = useDesktopStore((state) => state.registerRuntimeApp);
  const client = useMemo(() => (token ? new BwaManagerClient(token) : undefined), [token]);

  const refresh = async (activeClient = client) => {
    if (!activeClient) return;
    const status = await activeClient.status();
    setApplications(status.applications);
  };

  const execute = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setNotice("");
    try {
      await operation();
      await refresh();
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      const candidate = new BwaManagerClient(tokenInput);
      const status = await candidate.status();
      setApplications(status.applications);
      setToken(tokenInput);
      setTokenInput("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "解锁失败");
    } finally {
      setBusy(false);
    }
  };

  if (!client) {
    return (
      <article className="bwa-manager bwa-manager--locked">
        <form onSubmit={(event) => void unlock(event)}>
          <h1>Workspace Application Manager</h1>
          <p>输入 Biunivers 管理员密码以管理容器应用及其 Workspace 状态。</p>
          <input
            aria-label="管理员密码"
            type="password"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            autoComplete="current-password"
            required
          />
          <button type="submit" disabled={busy}>解锁</button>
          {notice && <p className="bwa-manager__notice">{notice}</p>}
        </form>
      </article>
    );
  }

  return (
    <article className="bwa-manager">
      <header>
        <div>
          <h1>Workspace Application Manager</h1>
          <p>每个 Instance 绑定一个可独立 Fork 和提交的 Workspace 状态。</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void refresh()}>刷新</button>
      </header>

      <form
        className="bwa-manager__install"
        onSubmit={(event) => {
          event.preventDefault();
          void execute(async () => {
            await client.install(reference.trim());
            setReference("");
          }, "应用安装完成");
        }}
      >
        <label>
          <span>OCI / GHCR 镜像</span>
          <input
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            placeholder="ghcr.io/owner/image:latest"
            required
          />
        </label>
        <button type="submit" disabled={busy}>安装</button>
      </form>

      {notice && <p className="bwa-manager__notice" role="status">{notice}</p>}
      <main>
        {applications.length === 0 ? (
          <p className="bwa-manager__empty">尚未安装 Workspace Application。</p>
        ) : applications.map((application) => (
          <ApplicationCard
            key={application.applicationId}
            application={application}
            client={client}
            busy={busy}
            execute={execute}
            onOpen={async (instance) => {
              setBusy(true);
              setNotice("正在等待应用就绪…");
              try {
                await client.waitUntilReady(instance.instanceIdHex);
                const opened = await client.open(instance.instanceIdHex);
                const appId = `bwa.${instance.instanceIdHex}`;
                registerRuntimeApp({
                  id: appId,
                  name: instance.displayName,
                  kind: "bwa",
                  icon: "/icons/workspaces.svg",
                  description: "Workspace Application Instance",
                  url: opened.url,
                  defaultWidth: 840,
                  defaultHeight: 600,
                  minWidth: 520,
                  minHeight: 360,
                  desktop: false,
                  pinned: false,
                  transient: true,
                });
                queueMicrotask(() => openApp(appId));
              } catch (error) {
                setNotice(error instanceof Error ? error.message : "打开失败");
              } finally {
                setBusy(false);
              }
            }}
          />
        ))}
      </main>
    </article>
  );
}

function ApplicationCard({
  application,
  client,
  busy,
  execute,
  onOpen,
}: {
  application: BwaApplicationSummary;
  client: BwaManagerClient;
  busy: boolean;
  execute: (operation: () => Promise<unknown>, success: string) => Promise<void>;
  onOpen: (instance: BwaInstanceSummary) => Promise<void>;
}) {
  const [instanceName, setInstanceName] = useState("");
  return (
    <section className="bwa-manager__application">
      <header>
        <div>
          <h2>{application.title}</h2>
          <code>{application.applicationId}</code>
          {application.description && <p>{application.description}</p>}
        </div>
        <div className="bwa-manager__actions">
          {application.sourceUrl && (
            <a href={application.sourceUrl} target="_blank" rel="noreferrer">源码</a>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const candidate = window.prompt("输入新的镜像 tag 或 digest", `${application.applicationId}:latest`);
              if (candidate) void execute(() => client.update(application.applicationId, candidate), "应用更新完成");
            }}
          >更新</button>
          <button
            type="button"
            disabled={busy || !application.previousDigest}
            onClick={() => void execute(() => client.rollback(application.applicationId), "已回退到上一镜像")}
          >回退</button>
        </div>
      </header>
      <form
        className="bwa-manager__new-instance"
        onSubmit={(event) => {
          event.preventDefault();
          void execute(async () => {
            await client.createInstance(application.applicationId, instanceName.trim());
            setInstanceName("");
          }, "Instance 创建完成");
        }}
      >
        <input
          aria-label="Instance 名称"
          value={instanceName}
          onChange={(event) => setInstanceName(event.target.value)}
          placeholder="新 Instance 名称"
          required
        />
        <button type="submit" disabled={busy}>创建 Instance</button>
      </form>
      {application.instances.map((instance) => (
        <InstanceCard
          key={instance.instanceIdHex}
          instance={instance}
          client={client}
          busy={busy}
          execute={execute}
          onOpen={onOpen}
        />
      ))}
    </section>
  );
}

function InstanceCard({ instance, client, busy, execute, onOpen }: {
  instance: BwaInstanceSummary;
  client: BwaManagerClient;
  busy: boolean;
  execute: (operation: () => Promise<unknown>, success: string) => Promise<void>;
  onOpen: (instance: BwaInstanceSummary) => Promise<void>;
}) {
  const running = instance.runs.some(({ run }) => run.state === "RUNNING");
  const unresolved = [...instance.runs].reverse().find(({ run }) =>
    run.state === "FAILED" || run.state === "CONFLICT");
  const [showEnvironment, setShowEnvironment] = useState(false);
  const [ordinary, setOrdinary] = useState(() => formatEnvironment(instance, false));
  const [sensitive, setSensitive] = useState(() => formatEnvironment(instance, true));
  return (
    <article className="bwa-manager__instance">
      <header>
        <div>
          <strong>{instance.displayName}</strong>
          <small>{running ? "运行中" : unresolved ? `需要处置：${unresolved.run.state}` : "已停止"}</small>
        </div>
        <div className="bwa-manager__actions">
          <button type="button" disabled={busy || running} onClick={() => void execute(() => client.action(instance.instanceIdHex, "start"), "Instance 已启动")}>启动</button>
          <button type="button" disabled={busy || !running} onClick={() => void onOpen(instance)}>打开</button>
          <button type="button" disabled={busy || !running} onClick={() => void execute(() => client.action(instance.instanceIdHex, "save-restart"), "状态已保存并重启")}>保存重启</button>
          <button type="button" disabled={busy || !running} onClick={() => void execute(() => client.action(instance.instanceIdHex, "stop"), "Instance 已停止并提交")}>停止</button>
          <button type="button" disabled={busy || running} onClick={() => setShowEnvironment((value) => !value)}>环境变量</button>
        </div>
      </header>
      {unresolved && (
        <div className="bwa-manager__recovery">
          <span>异常改动尚未处理。</span>
          <button type="button" disabled={busy} onClick={() => void execute(() => client.requestRecovery(instance.instanceIdHex, unresolved.run.runIdHex, "publish"), "异常改动已提交")}>提交改动</button>
          <button type="button" disabled={busy} onClick={() => void execute(() => client.requestRecovery(instance.instanceIdHex, unresolved.run.runIdHex, "discard"), "异常改动已丢弃")}>丢弃改动</button>
        </div>
      )}
      {showEnvironment && (
        <form
          className="bwa-manager__environment"
          onSubmit={(event) => {
            event.preventDefault();
            void execute(
              () => client.replaceEnvironment(instance.instanceIdHex, parseEnvironment(ordinary), parseEnvironment(sensitive)),
              "环境变量已保存，将在下次启动时生效",
            );
          }}
        >
          <label><span>普通变量（每行 KEY=value）</span><textarea value={ordinary} onChange={(event) => setOrdinary(event.target.value)} /></label>
          <label><span>Secret（保存时必须重新填写全部值）</span><textarea value={sensitive} onChange={(event) => setSensitive(event.target.value)} /></label>
          <button type="submit" disabled={busy}>保存环境变量</button>
        </form>
      )}
    </article>
  );
}

function formatEnvironment(instance: BwaInstanceSummary, sensitive: boolean): string {
  return instance.environment
    .filter((item) => item.sensitive === sensitive)
    .map((item) => `${item.name}=${item.value ?? ""}`)
    .join("\n");
}

function parseEnvironment(value: string): Record<string, string> {
  return Object.fromEntries(value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`环境变量格式无效：${line}`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1)];
  }));
}
