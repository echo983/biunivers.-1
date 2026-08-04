import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AppManagementClient,
  AppManagementError,
  type ConfigurationDefinition,
  type InspectionResult,
  type InstalledApp,
} from "../../api/appManagementClient";
import { refreshApplicationRegistry } from "../../app/bootstrap";
import { useDesktopSurfaceStore } from "../../desktopSurface/store";
import { useDesktopStore } from "../../store/desktopStore";
import { closeApp } from "../../windows/windowController";

type FormValue = string | number | boolean;

function initialConfiguration(definitions: ConfigurationDefinition[]) {
  return Object.fromEntries(
    definitions.map((definition) => [
      definition.key,
      definition.default ??
        (definition.type === "boolean" ? false : ""),
    ]),
  ) as Record<string, FormValue>;
}

function configurationForDefinitions(
  definitions: ConfigurationDefinition[],
  current?: Record<string, string | number | boolean>,
) {
  const initial = initialConfiguration(definitions);
  if (!current) return initial;
  for (const definition of definitions) {
    if (Object.hasOwn(current, definition.key)) {
      initial[definition.key] = current[definition.key];
    }
  }
  return initial;
}

function serializeConfiguration(
  definitions: ConfigurationDefinition[],
  values: Record<string, FormValue>,
) {
  const result: Record<string, string | number | boolean> = {};
  for (const definition of definitions) {
    const value = values[definition.key];
    if (value === "" && !definition.required) {
      continue;
    }
    if (definition.type === "integer" || definition.type === "number") {
      result[definition.key] = Number(value);
    } else {
      result[definition.key] = value;
    }
  }
  return result;
}

function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof Error ? error.message : "操作失败，请稍后重试";
  const details =
    error instanceof AppManagementError ? error.details ?? [] : [];

  return (
    <div className="settings-app__error" role="alert">
      <p>{message}</p>
      {details.length > 0 && (
        <ul>
          {details.map((detail, index) => (
            <li key={`${detail.path ?? "error"}-${index}`}>
              {detail.path ? `${detail.path}：` : ""}
              {detail.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConfigurationField({
  definition,
  value,
  onChange,
}: {
  definition: ConfigurationDefinition;
  value: FormValue;
  onChange: (value: FormValue) => void;
}) {
  const id = `app-config-${definition.key}`;

  if (definition.type === "boolean") {
    return (
      <label className="app-management__checkbox" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          {definition.label}
          {definition.description && <small>{definition.description}</small>}
        </span>
      </label>
    );
  }

  return (
    <label className="app-management__field" htmlFor={id}>
      <span>
        {definition.label}
        {definition.required ? "（必填）" : ""}
      </span>
      {definition.type === "select" ? (
        <select
          id={id}
          required={definition.required}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          {!definition.required && <option value="">使用应用默认值</option>}
          {definition.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          required={definition.required}
          type={
            definition.type === "integer" || definition.type === "number"
              ? "number"
              : "text"
          }
          step={definition.type === "integer" ? 1 : undefined}
          min={
            definition.type === "integer" || definition.type === "number"
              ? definition.minimum
              : undefined
          }
          max={
            definition.type === "integer" || definition.type === "number"
              ? definition.maximum
              : undefined
          }
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {definition.description && <small>{definition.description}</small>}
    </label>
  );
}

export function AppManagement() {
  const pinApp = useDesktopStore((state) => state.pinApp);
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [repository, setRepository] = useState("");
  const [ref, setRef] = useState("main");
  const [inspection, setInspection] = useState<InspectionResult | null>(null);
  const [editingApp, setEditingApp] = useState<InstalledApp | null>(null);
  const [configuration, setConfiguration] = useState<
    Record<string, FormValue>
  >({});
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const client = useMemo(() => new AppManagementClient(), []);

  useEffect(() => {
    let active = true;
    void client.list().then(
      (apps) => {
        if (active) setInstalledApps(apps);
      },
      (loadError) => {
        if (active) setError(loadError);
      },
    ).finally(() => {
      if (active) setBusy(false);
    });
    return () => {
      active = false;
    };
  }, [client]);

  const inspect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(null);
    setInspection(null);
    try {
      const result = await client.inspect(repository.trim(), ref.trim());
      setInspection(result);
      const current = installedApps.find(
        (app) => app.appId === result.manifest.appId,
      );
      setConfiguration(
        configurationForDefinitions(
          result.manifest.configuration,
          current?.configuration,
        ),
      );
    } catch (inspectionError) {
      setError(inspectionError);
    } finally {
      setBusy(false);
    }
  };

  const install = async (event: FormEvent) => {
    event.preventDefault();
    if (!client || !inspection) return;
    setBusy(true);
    setError(null);
    try {
      const finalConfiguration = serializeConfiguration(
        inspection.manifest.configuration,
        configuration,
      );
      const installed =
        inspection.operation === "install"
          ? await client.install(
              inspection.inspectionId,
              finalConfiguration,
            )
          : await client.update(
              inspection.manifest.appId,
              inspection.inspectionId,
              finalConfiguration,
            );
      await refreshApplicationRegistry();
      await useDesktopSurfaceStore.getState().load();
      if (
        inspection.operation === "install" &&
        inspection.manifest.window.pinned
      ) {
        pinApp(installed.appId);
      }
      setInstalledApps(await client.list());
      setSuccess(
        `“${inspection.manifest.name}”${
          inspection.operation === "install" ? "安装" : "更新"
        }成功`,
      );
      setInspection(null);
      setRepository("");
      setRef("main");
    } catch (installError) {
      setError(installError);
    } finally {
      setBusy(false);
    }
  };

  const saveConfiguration = async (event: FormEvent) => {
    event.preventDefault();
    if (!client || !editingApp) return;
    setBusy(true);
    setError(null);
    try {
      await client.patch(editingApp.appId, {
        configuration: serializeConfiguration(
          editingApp.manifest.configuration,
          configuration,
        ),
      });
      setInstalledApps(await client.list());
      setEditingApp(null);
      setSuccess(`“${editingApp.manifest.name}”配置已保存，重新打开后生效`);
    } catch (configurationError) {
      setError(configurationError);
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (app: InstalledApp) => {
    setBusy(true);
    setError(null);
    try {
      const nextStatus = app.status === "active" ? "disabled" : "active";
      await client.patch(app.appId, { status: nextStatus });
      if (nextStatus === "disabled") {
        closeApp(app.appId);
      }
      await refreshApplicationRegistry();
      await useDesktopSurfaceStore.getState().load();
      setInstalledApps(await client.list());
      setSuccess(
        `“${app.manifest.name}”已${
          nextStatus === "active" ? "启用" : "停用"
        }`,
      );
    } catch (statusError) {
      setError(statusError);
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async (app: InstalledApp) => {
    if (
      !client ||
      !window.confirm(
        `确定卸载“${app.manifest.name}”吗？服务器端应用文件和配置将被移除；浏览器本地数据可能仍然保留。`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.uninstall(app.appId);
      closeApp(app.appId);
      await refreshApplicationRegistry();
      await useDesktopSurfaceStore.getState().load();
      setInstalledApps(await client.list());
      setSuccess(`“${app.manifest.name}”已卸载`);
      if (editingApp?.appId === app.appId) {
        setEditingApp(null);
      }
    } catch (uninstallError) {
      setError(uninstallError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="app-management" aria-labelledby="app-management-title">
      <div className="app-management__heading">
        <div>
          <h2 id="app-management-title">应用管理</h2>
          <p>由当前 Biunivers 桌面直接管理第三方应用。</p>
        </div>
      </div>

      <form className="app-management__install" onSubmit={inspect}>
        <h3>从 GitHub 安装</h3>
        <label className="app-management__field" htmlFor="app-repository">
          <span>公开仓库 URL</span>
          <input
            id="app-repository"
            type="url"
            placeholder="https://github.com/owner/repository"
            required
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
          />
        </label>
        <label className="app-management__field" htmlFor="app-ref">
          <span>Branch、tag 或 commit</span>
          <input
            id="app-ref"
            required
            value={ref}
            onChange={(event) => setRef(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "正在检查……" : "检查仓库"}
        </button>
      </form>

      {inspection && (
        <form className="app-management__inspection" onSubmit={install}>
          <h3>确认{inspection.operation === "install" ? "安装" : "更新"}</h3>
          <dl>
            <div>
              <dt>应用</dt>
              <dd>{inspection.manifest.name}</dd>
            </div>
            <div>
              <dt>应用 ID</dt>
              <dd>{inspection.manifest.appId}</dd>
            </div>
            <div>
              <dt>版本</dt>
              <dd>{inspection.manifest.version}</dd>
            </div>
            <div>
              <dt>Commit</dt>
              <dd>{inspection.commitSha.slice(0, 12)}</dd>
            </div>
            <div>
              <dt>许可证</dt>
              <dd>{inspection.manifest.license}</dd>
            </div>
          </dl>
          {inspection.manifest.description && (
            <p>{inspection.manifest.description}</p>
          )}
          {inspection.openResource && (
            <section aria-labelledby="open-resource-handlers-title">
              <h4 id="open-resource-handlers-title">文件处理能力</h4>
              <ul>
                {inspection.openResource.handlers.map((handler) => (
                  <li key={handler.id}>
                    <strong>{handler.extensions.join("、")}</strong>
                    {" · "}
                    {handler.actions.join(" / ")}
                    {" · "}
                    {handler.access === "read-write" ? "最大读写" : "只读"}
                  </li>
                ))}
              </ul>
              <p className="app-management__notice">
                该声明只登记候选处理器，不会自动授予文件权限或设为默认应用。
              </p>
            </section>
          )}
          {inspection.manifest.configuration.map((definition) => (
            <ConfigurationField
              key={definition.key}
              definition={definition}
              value={configuration[definition.key] ?? ""}
              onChange={(value) =>
                setConfiguration((current) => ({
                  ...current,
                  [definition.key]: value,
                }))
              }
            />
          ))}
          <p className="app-management__notice">
            安装配置会发送到浏览器，请勿填写密码、私钥或长期 token。
          </p>
          <div className="app-management__actions">
            <button
              type="button"
              onClick={() => setInspection(null)}
              disabled={busy}
            >
              取消
            </button>
            <button type="submit" disabled={busy}>
              {busy ? "正在安装……" : "确认安装"}
            </button>
          </div>
        </form>
      )}

      <ErrorMessage error={error} />
      {success && (
        <p className="app-management__success" role="status">
          {success}
        </p>
      )}

      <div className="app-management__installed">
        <h3>已安装应用</h3>
        {installedApps.length === 0 ? (
          <p>尚未安装第三方应用。</p>
        ) : (
          <ul>
            {installedApps.map((app) => (
              <li key={app.appId}>
                <div>
                  <strong>{app.manifest.name}</strong>
                  <span>{app.appId}</span>
                  <small>
                    {app.version} · {app.commitSha.slice(0, 8)} · {app.status}
                  </small>
                </div>
                <div className="app-management__item-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setRepository(app.repository);
                      setRef(app.requestedRef);
                      setInspection(null);
                      setSuccess("请修改目标 ref，然后重新检查仓库");
                    }}
                  >
                    更新
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditingApp(app);
                      setConfiguration(
                        configurationForDefinitions(
                          app.manifest.configuration,
                          app.configuration,
                        ),
                      );
                    }}
                  >
                    配置
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => toggleStatus(app)}
                  >
                    {app.status === "active" ? "停用" : "启用"}
                  </button>
                  <button
                    className="settings-app__danger"
                    type="button"
                    disabled={busy}
                    onClick={() => uninstall(app)}
                  >
                    卸载
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {editingApp && (
        <form
          className="app-management__inspection"
          onSubmit={saveConfiguration}
        >
          <h3>配置“{editingApp.manifest.name}”</h3>
          {editingApp.manifest.configuration.length === 0 ? (
            <p>此应用没有安装配置。</p>
          ) : (
            editingApp.manifest.configuration.map((definition) => (
              <ConfigurationField
                key={definition.key}
                definition={definition}
                value={configuration[definition.key] ?? ""}
                onChange={(value) =>
                  setConfiguration((current) => ({
                    ...current,
                    [definition.key]: value,
                  }))
                }
              />
            ))
          )}
          <p className="app-management__notice">
            配置会发送到浏览器，不能用于保存 secret。
          </p>
          <div className="app-management__actions">
            <button type="button" onClick={() => setEditingApp(null)}>
              取消
            </button>
            <button type="submit" disabled={busy}>
              保存配置
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
