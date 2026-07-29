import {
  createResourceLaunch,
  resolveResourceHandlers,
} from "../api/internalFileManagerClient";
import {
  closeHostInstance,
  createHostInstance,
} from "../hostApi/instanceClient";
import {
  selectResourceHandler,
} from "../openResource/defaultResourceHandlers";
import { useDesktopStore } from "../store/desktopStore";
import { openApp } from "../windows/windowController";
import { queueDirectoryLaunch } from "./directoryLaunchBroker";
import type { DesktopItem } from "./types";

export async function activateDesktopItem(item: DesktopItem) {
  if (!item.resolved.available) {
    throw new Error(item.resolved.reason ?? "桌面项目当前不可用");
  }
  if (item.target.type === "app") {
    openApp(item.target.handle);
    return;
  }
  if (item.target.type === "directory") {
    queueDirectoryLaunch(item.target.handle);
    openApp("system.files");
    return;
  }
  if (item.resolved.fileRevision === undefined) {
    throw new Error("文件版本信息不可用，请刷新桌面后重试");
  }

  const instance = await createHostInstance(
    "system.files",
    crypto.randomUUID(),
  );
  if (!instance) {
    throw new Error("当前宿主尚未启用文件能力");
  }
  try {
    const resolution = await resolveResourceHandlers(
      instance.instanceToken,
      item.target.handle,
      item.resolved.fileRevision,
      "edit",
    );
    if (resolution.candidates.length === 0) {
      throw new Error(`没有能够打开“${item.resolved.name}”的应用`);
    }
    const defaults =
      useDesktopStore.getState().defaultResourceHandlers;
    const candidate =
      selectResourceHandler(
        resolution.candidates,
        defaults,
        resolution.extension ?? "",
        resolution.effectiveAction,
      ) ??
      (resolution.candidates.length === 1
        ? resolution.candidates[0]
        : undefined);
    if (!candidate) {
      throw new Error(
        `“${item.resolved.name}”有多个打开方式，请先在文件管理器中选择默认应用`,
      );
    }
    const launch = await createResourceLaunch(instance.instanceToken, {
      entryId: item.target.handle,
      expectedRevision: resolution.revision,
      targetAppId: candidate.appId,
      handlerId: candidate.handler.id,
      action: resolution.effectiveAction,
    });
    openApp(candidate.appId, { launchId: launch.launchId });
  } finally {
    await closeHostInstance(instance.instanceToken).catch(() => undefined);
  }
}
