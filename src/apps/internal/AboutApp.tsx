export function AboutApp() {
  return (
    <article className="about-app">
      <div className="about-app__mark" aria-hidden="true">
        B
      </div>
      <div>
        <h1>Biunivers 桌面</h1>
        <p className="about-app__version">版本 0.1.0</p>
      </div>
      <p>
        一个部署在个人服务器上、通过浏览器访问的轻量个人桌面入口。
      </p>
      <dl>
        <div>
          <dt>窗口引擎</dt>
          <dd>WinBox.js</dd>
        </div>
        <div>
          <dt>界面</dt>
          <dd>React + TypeScript</dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>Zustand</dd>
        </div>
      </dl>
    </article>
  );
}
