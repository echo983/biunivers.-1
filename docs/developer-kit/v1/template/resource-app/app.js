import {
  claimLaunch,
  chooseFile,
  getCapabilities,
  onLaunchAvailable,
  saveAs,
} from "./resource-session.js";

const editor = document.querySelector("textarea");
const name = document.querySelector("#name");
const status = document.querySelector("footer");
const saveButton = document.querySelector("#save");
let current = null;
let busy = false;

function show(message, failed = false) {
  status.textContent = message;
  status.style.color = failed ? "#a12d2d" : "";
}

async function replaceResource(resource) {
  const response = await resource.read();
  if (!response.ok) throw new Error(`读取失败：HTTP ${response.status}`);
  const text = await response.text();
  await current?.release();
  current = resource;
  editor.value = text;
  editor.readOnly = resource.session.access !== "edit";
  name.textContent = resource.session.metadata.name;
  saveButton.disabled = editor.readOnly;
  show(`已打开 ${resource.session.metadata.name}`);
}

async function run(action) {
  if (busy) return;
  busy = true;
  try {
    await action();
  } catch (error) {
    if (error.code !== "USER_CANCELLED") {
      show(error.message || "操作失败", true);
    }
  } finally {
    busy = false;
  }
}

document.querySelector("#open").addEventListener("click", () => {
  void run(async () => replaceResource(await chooseFile("edit")));
});

saveButton.addEventListener("click", () => {
  void run(async () => {
    const response = await current.save(editor.value);
    if (!response.ok) throw new Error(`保存失败：HTTP ${response.status}`);
    show("已保存");
  });
});

document.querySelector("#save-as").addEventListener("click", () => {
  void run(async () => {
    const resource = await saveAs(
      current?.session.metadata.name || "untitled.txt",
    );
    const response = await resource.save(editor.value);
    if (!response.ok) {
      await resource.release();
      throw new Error(`另存为失败：HTTP ${response.status}`);
    }
    await current?.release();
    current = resource;
    editor.readOnly = false;
    name.textContent = resource.session.metadata.name;
    saveButton.disabled = false;
    show("已另存为");
  });
});

onLaunchAvailable(() => {
  void run(async () => {
    const launch = await claimLaunch();
    await replaceResource(launch.resource);
  });
});

setInterval(() => {
  if (current) void current.renew().catch(() => show("文件会话续租失败", true));
}, 60_000);

window.addEventListener("beforeunload", () => {
  if (current) void current.release();
});

void run(async () => {
  await getCapabilities();
  show("就绪 · Resource Session v1");
  try {
    const launch = await claimLaunch();
    await replaceResource(launch.resource);
  } catch (error) {
    if (error.code !== "NO_LAUNCH_CONTEXT") throw error;
  }
});
