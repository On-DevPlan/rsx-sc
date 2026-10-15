// 面板壳：tab 导航 + 当前视图。**这个文件几乎不需要改**——
// 新增面板 = 在 registry.js 登记一行 + 写一个 view.jsx。
import { Suspense, useEffect, useRef } from 'react';
import { VIEWS } from './registry.js';
import { useStore } from './store.jsx';
import { ErrorBoundary } from './components/ui.jsx';

function viewFromHash() {
  const h = location.hash.replace(/^#\/?/, '');
  return h || '';
}

export default function App() {
  const { ui, patchUi, boot, refreshBoot } = useStore();
  const views = VIEWS;

  // 窗口聚焦时刷新 bootstrap：别的终端改了状态，这里能看到。
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') refreshBoot().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refreshBoot]);

  // 启动时把 hash 同步进 store；后续切换时也回写 hash（可分享、可后退）
  useEffect(() => {
    const fromHash = viewFromHash();
    if (fromHash && fromHash !== ui.view) patchUi({ view: fromHash });
    else if (!location.hash && ui.view) location.hash = '#/' + ui.view;
  }, []);

  // 回写 hash。**首次渲染必须跳过**：挂载那一刻 ui.view 还是 localStorage 里的
  // 旧值，无条件回写会把深链接（别人分享的 #/capture）冲成 #/home，紧接着
  // 触发的 hashchange 又把 state 也改回去——表现就是「打开链接却回到首页」。
  const hashWriteReady = useRef(false);
  useEffect(() => {
    if (!hashWriteReady.current) {
      hashWriteReady.current = true;
      return;
    }
    if (ui.view) location.hash = '#/' + ui.view;
  }, [ui.view]);

  useEffect(() => {
    const onHash = () => patchUi({ view: viewFromHash() });
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [patchUi]);

  const current = views.find((v) => v.id === ui.view) || views[0];
  const appName = boot?.app?.name || 'rsx-sc';

  return (
    <>
      <header>
        <div className="brand">
          <img src="/logo-rounded.png" alt="" />
          {appName}
          <span className="sub">本机工具：CLI 与 Web 面板同源</span>
        </div>
        <nav>
          {views.map((v) => (
            <button
              key={v.id}
              className={'tab' + (current && current.id === v.id ? ' active' : '')}
              onClick={() => patchUi({ view: v.id })}
            >
              {v.title}
            </button>
          ))}
          {views.length === 0 && (
            <span className="muted" style={{ padding: '6px 12px' }}>
              暂无视图
            </span>
          )}
        </nav>
        <div className="meta">{boot ? `v${boot.app.version}` : ''}</div>
      </header>
      <main>
        {!current ? (
          <div className="empty">
            <p>
              还没有注册任何视图。在 <code>src/modules/&lt;域&gt;/view.jsx</code> 写一个，
              再在 <code>src/web/frontend/registry.js</code> 登记一行。
            </p>
            <p>
              CLI 已就绪：<code>{appName} help</code> / <code>{appName} routes</code>。
            </p>
          </div>
        ) : (
          <ErrorBoundary key={current.id}>
            <Suspense fallback={<div className="muted" style={{ padding: 24 }}>加载中…</div>}>
              <section className="panel active">
                <current.component />
              </section>
            </Suspense>
          </ErrorBoundary>
        )}
      </main>
    </>
  );
}
