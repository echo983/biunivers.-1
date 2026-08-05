import { useEffect, useMemo, useState } from "react";
import {
  BwaManagerClient,
  type BwaApplicationSummary,
  type BwaInstanceSummary,
  type BwaRunSummary,
  type BwaWorkspaceOption,
} from "../../api/bwaManagerClient";
import { useDesktopStore } from "../../store/desktopStore";
import { closeApp, openApp } from "../../windows/windowController";

export function BwaManagerApp() {
  const [applications, setApplications] = useState<BwaApplicationSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<BwaWorkspaceOption[]>([]);
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const registerRuntimeApp = useDesktopStore((state) => state.registerRuntimeApp);
  const client = useMemo(() => new BwaManagerClient(), []);

  const refresh = async (activeClient = client) => {
    const status = await activeClient.status();
    setApplications(status.applications);
    setWorkspaces(status.workspaces);
  };

  const execute = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setNotice("");
    try {
      await operation();
      await refresh();
      setNotice(success);
    } catch (error) {
      await refresh().catch(() => undefined);
      setNotice(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    void client.status().then(
      (status) => {
        if (!active) return;
        setApplications(status.applications);
        setWorkspaces(status.workspaces);
      },
      (error) => {
        if (active) setNotice(error instanceof Error ? error.message : "加载失败");
      },
    ).finally(() => {
      if (active) setBusy(false);
    });
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <article className="bwa-manager">
      <header>
        <div>
          <h1>工作空间应用管理</h1>
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
            workspaces={workspaces}
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
                setNotice("");
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
  workspaces,
  client,
  busy,
  execute,
  onOpen,
}: {
  application: BwaApplicationSummary;
  workspaces: BwaWorkspaceOption[];
  client: BwaManagerClient;
  busy: boolean;
  execute: (operation: () => Promise<unknown>, success: string) => Promise<void>;
  onOpen: (instance: BwaInstanceSummary) => Promise<void>;
}) {
  const [instanceName, setInstanceName] = useState("");
  const [sourceWorkspaceIdHex, setSourceWorkspaceIdHex] = useState("");
  const [showEnvironment, setShowEnvironment] = useState(false);
  const [ordinary, setOrdinary] = useState(() => formatVariables(application.environment, false));
  const [sensitive, setSensitive] = useState(() => formatVariables(application.environment, true));
  return (
    <section className="bwa-manager__application">
      <header>
        <div>
          <h2>{application.title}</h2>
          <code>{application.applicationId}</code>
          <small className="bwa-manager__image-identity">
            版本 {application.imageVersion ?? "未声明"} · {shortDigest(application.installedDigest)}
          </small>
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
          <button type="button" disabled={busy} onClick={() => setShowEnvironment((value) => !value)}>默认环境</button>
          <button
            type="button"
            disabled={busy || application.instances.length > 0}
            title={application.instances.length > 0 ? "请先移除全部 Instance" : "卸载应用注册"}
            onClick={() => {
              if (window.confirm(`卸载“${application.title}”？本地镜像不会自动删除。`)) {
                void execute(() => client.uninstall(application.applicationId), "应用已卸载");
              }
            }}
          >卸载</button>
        </div>
      </header>
      {showEnvironment && (
        <form className="bwa-manager__environment" onSubmit={(event) => {
          event.preventDefault();
          void execute(async () => {
            await client.replaceApplicationEnvironment(
              application.applicationId,
              parseEnvironment(ordinary),
              parseEnvironment(sensitive),
            );
            setSensitive("");
            setShowEnvironment(false);
          }, "应用默认环境已保存，将由 Instance 在下次启动时继承");
        }}>
          <label><span>默认普通变量（每行 KEY=value）</span><textarea value={ordinary} onChange={(event) => setOrdinary(event.target.value)} /></label>
          <label><span>默认 Secret（保存时必须重新填写全部值）</span><textarea value={sensitive} onChange={(event) => setSensitive(event.target.value)} /></label>
          <button type="submit" disabled={busy}>保存默认环境</button>
        </form>
      )}
      <form
        className="bwa-manager__new-instance"
        onSubmit={(event) => {
          event.preventDefault();
          void execute(async () => {
            await client.createInstance(
              application.applicationId,
              instanceName.trim(),
              sourceWorkspaceIdHex || undefined,
            );
            setInstanceName("");
            setSourceWorkspaceIdHex("");
          }, "Instance 与独立 Workspace 已创建");
        }}
      >
        <input
          aria-label="Instance 名称"
          value={instanceName}
          onChange={(event) => setInstanceName(event.target.value)}
          placeholder="新 Instance 名称"
          required
        />
        <select
          aria-label="Workspace 来源"
          title="Workspace 来源：新建空白状态，或从已有 Workspace 的当前 revision 派生"
          value={sourceWorkspaceIdHex}
          onChange={(event) => setSourceWorkspaceIdHex(event.target.value)}
        >
          <option value="">新建空白 Workspace</option>
          {workspaces.map((workspace) => (
            <option key={workspace.workspaceIdHex} value={workspace.workspaceIdHex}>
              从「{workspace.name}」Fork · revision {workspace.revision}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy}>创建 Instance</button>
      </form>
      {application.instances.map((instance) => (
        <InstanceCard
          key={instance.instanceIdHex}
          instance={instance}
          applicationEnvironment={application.environment}
          workspace={workspaces.find((item) => item.workspaceIdHex === instance.workspaceIdHex)}
          client={client}
          busy={busy}
          execute={execute}
          onOpen={onOpen}
        />
      ))}
    </section>
  );
}

function InstanceCard({ instance, applicationEnvironment, workspace, client, busy, execute, onOpen }: {
  instance: BwaInstanceSummary;
  applicationEnvironment: BwaApplicationSummary["environment"];
  workspace?: BwaWorkspaceOption;
  client: BwaManagerClient;
  busy: boolean;
  execute: (operation: () => Promise<unknown>, success: string) => Promise<void>;
  onOpen: (instance: BwaInstanceSummary) => Promise<void>;
}) {
  const running = instance.runs.some(({ run }) => run.state === "RUNNING");
  const unresolved = [...instance.runs].reverse().find(({ run }) =>
    run.state === "FAILED" || run.state === "CONFLICT");
  const latestRun = instance.runs.at(-1);
  const startupFailure = latestRun?.startupFailure;
  const [dismissedFailureRunId, setDismissedFailureRunId] = useState<string | null>(null);
  const [showEnvironment, setShowEnvironment] = useState(false);
  const [ordinary, setOrdinary] = useState(() => formatEnvironment(instance, false));
  const [sensitive, setSensitive] = useState(() => formatEnvironment(instance, true));
  return (
    <article className="bwa-manager__instance">
      <header>
        <div>
          <strong>{instance.displayName}</strong>
          <small>{running ? "运行中" : unresolved ? `需要处置：${unresolved.run.state}` : "已停止"}</small>
          <small>
            Workspace：{workspace
              ? `${workspace.name} · revision ${workspace.revision}`
              : instance.workspaceIdHex.slice(0, 8)}
          </small>
        </div>
        <div className="bwa-manager__actions">
          <button type="button" disabled={busy || running} onClick={() => void execute(() => client.action(instance.instanceIdHex, "start"), "Instance 已启动")}>启动</button>
          <button type="button" disabled={busy || !running} onClick={() => void onOpen(instance)}>打开</button>
          <button type="button" disabled={busy || !running} onClick={() => void execute(() => client.action(instance.instanceIdHex, "save-restart"), "状态已保存并重启")}>保存重启</button>
          <button type="button" disabled={busy || !running} onClick={() => void execute(() => client.action(instance.instanceIdHex, "stop"), "Instance 已停止并提交")}>停止</button>
          <button type="button" disabled={busy || running} onClick={() => setShowEnvironment((value) => !value)}>环境变量</button>
          <button
            type="button"
            disabled={busy || running || Boolean(unresolved)}
            title={running ? "请先停止 Instance" : unresolved ? "请先处置异常改动" : "移除 Instance，保留 Workspace"}
            onClick={() => {
              if (window.confirm(`移除“${instance.displayName}”？Workspace 将被保留。`)) {
                void execute(async () => {
                  await client.deleteInstance(instance.instanceIdHex);
                  closeApp(`bwa.${instance.instanceIdHex}`);
                }, "Instance 已移除，Workspace 已保留");
              }
            }}
          >移除</button>
        </div>
      </header>
      {startupFailure && latestRun.run.runIdHex !== dismissedFailureRunId && (
        <div className="bwa-manager__startup-failure" role="alert">
          <div className="bwa-manager__startup-failure-heading">
            <strong>启动失败</strong>
            <button
              type="button"
              aria-label="关闭启动失败提示"
              onClick={() => setDismissedFailureRunId(latestRun.run.runIdHex)}
            >关闭</button>
          </div>
          <span>{startupFailure.summary}</span>
          <small>
            阶段：{startupStageLabel(startupFailure.stage)}
            {startupFailure.exitCode === null ? "" : ` · 退出码：${startupFailure.exitCode}`}
          </small>
          {startupFailure.logTail && (
            <details>
              <summary>查看日志</summary>
              <pre>{startupFailure.logTail}</pre>
            </details>
          )}
        </div>
      )}
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
              async () => {
                await client.replaceEnvironment(
                  instance.instanceIdHex,
                  parseEnvironment(ordinary),
                  parseEnvironment(sensitive),
                );
                setSensitive("");
                setShowEnvironment(false);
              },
              "环境变量已保存，将在下次启动时生效",
            );
          }}
        >
          {applicationEnvironment.length > 0 && (
            <p className="bwa-manager__environment-inherited">
              继承应用默认值：{applicationEnvironment.map((item) => item.name).join("、")}。在此填写同名变量即可覆盖。
            </p>
          )}
          <label><span>普通变量（每行 KEY=value）</span><textarea value={ordinary} onChange={(event) => setOrdinary(event.target.value)} /></label>
          <label><span>Secret（保存时必须重新填写全部值）</span><textarea value={sensitive} onChange={(event) => setSensitive(event.target.value)} /></label>
          <button type="submit" disabled={busy}>保存环境变量</button>
        </form>
      )}
    </article>
  );
}

function startupStageLabel(stage: NonNullable<BwaRunSummary["startupFailure"]>["stage"]): string {
  return ({
    IMAGE_PREPARE: "准备镜像",
    RUNTIME_PREPARE: "准备运行环境",
    APPLICATION_START: "启动应用",
    HEALTH_CHECK: "等待应用就绪",
  } as const)[stage];
}

function formatEnvironment(instance: BwaInstanceSummary, sensitive: boolean): string {
  return formatVariables(instance.environment, sensitive);
}

function formatVariables(
  variables: Array<{ name: string; value: string | null; sensitive: boolean }>,
  sensitive: boolean,
): string {
  return variables
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

function shortDigest(value: string): string {
  return value.startsWith("sha256:") ? `sha256:${value.slice(7, 19)}` : value.slice(0, 19);
}
