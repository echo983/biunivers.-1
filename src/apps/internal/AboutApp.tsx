import packageJson from "../../../package.json";

export function AboutApp() {
  return (
    <article className="about-app">
      <div className="about-app__mark" aria-hidden="true">
        B
      </div>
      <div>
        <h1>Biunivers 桌面</h1>
        <p className="about-app__version">版本 {packageJson.version}</p>
      </div>
      <p>
        一个部署在个人服务器上、通过浏览器访问的轻量个人桌面。
        当前版本已具备自由布局桌面、窗口、原子批量文件操作、目录 ZIP 导出、
        Wormhole 文件交换、固定快照 Workspace、隔离计算与 COW 提交、
        变更审阅和原子导回、Workspace Application 容器应用与平行状态，
        应用默认环境与 Instance 覆盖、main 向既有 Workspace 的原子内容补充，
        Open Resource v1.1 多资源交付、第三方静态应用闭环、Debian 单机 Release
        与失败可回滚更新，以及单一主人控制面。
      </p>
      <dl>
        <div>
          <dt>桌面</dt>
          <dd>应用、文件与目录快捷入口</dd>
        </div>
        <div>
          <dt>文件</dt>
          <dd>
            File Service · 批量操作 · ZIP 导出 · Wormhole · Resource
            Session v1
          </dd>
        </div>
        <div>
          <dt>工作空间</dt>
          <dd>PVLogFS · 隔离 Run · COW 提交 · Fork · Diff · 双向受控导入</dd>
        </div>
        <div>
          <dt>应用</dt>
          <dd>Static App v1 · Workspace Application v1 · 默认环境与实例覆盖</dd>
        </div>
        <div>
          <dt>窗口</dt>
          <dd>WinBox.js</dd>
        </div>
        <div>
          <dt>控制</dt>
          <dd>单一主人 · 桌面同源 · 应用能力隔离</dd>
        </div>
        <div>
          <dt>部署</dt>
          <dd>Debian 12/13 · systemd · 固定 Release · 事务更新</dd>
        </div>
      </dl>
    </article>
  );
}
