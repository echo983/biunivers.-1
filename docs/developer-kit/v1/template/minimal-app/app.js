const query = new URLSearchParams(window.location.search);
const locale = query.get("biunivers_locale") ?? "zh-CN";
const theme = query.get("biunivers_theme") ?? "system";

async function loadConfig() {
  try {
    const response = await fetch("./.biunivers/config.json", {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } catch {
    return {};
  }
}

const config = await loadConfig();
const greeting = config.greeting ?? "你好，Biunivers";

document.documentElement.dataset.theme = theme;
document.documentElement.lang = locale;
document.querySelector("#message").textContent = greeting;

let count = 0;
const counter = document.querySelector("#counter");
counter.addEventListener("click", () => {
  count += 1;
  counter.textContent = `点击次数：${count}`;
});
