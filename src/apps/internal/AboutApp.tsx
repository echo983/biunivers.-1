export function AboutApp() {
  return (
    <article className="about-app">
      <div className="about-app__mark" aria-hidden="true">
        B
      </div>
      <div>
        <h1>Biunivers 桌面</h1>
        <p className="about-app__version">版本 0.7.0</p>
      </div>
      <p>
        一个部署在个人服务器上、通过浏览器访问的轻量个人桌面。
        当前版本已具备自由布局桌面、窗口、文件和第三方静态应用闭环。
      </p>
      <dl>
        <div>
          <dt>桌面</dt>
          <dd>应用、文件与目录快捷入口</dd>
        </div>
        <div>
          <dt>文件</dt>
          <dd>Biunivers File Service</dd>
        </div>
        <div>
          <dt>应用</dt>
          <dd>Biunivers Static App Protocol v1</dd>
        </div>
        <div>
          <dt>窗口</dt>
          <dd>WinBox.js</dd>
        </div>
      </dl>
    </article>
  );
}
