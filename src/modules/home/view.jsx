// 首页视图：模板自带的最小示例。
//
// 它示范了三件事，照着改就能长出你自己的面板：
//   1. 数据从 /api 拉（不是硬编码），失败有兜底
//   2. 每个 Web 操作都配一行等价的 CLI 命令，两端不会分叉
//   3. 用 .card / .row / .tag 这些原子类，不自己写样式
import { useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useStore } from '../../web/frontend/store.jsx';

export default function HomeView() {
  const { boot } = useStore();
  const [routes, setRoutes] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api('/api/routes')
      .then((r) => setRoutes(r))
      .catch((e) => setErr(String(e.message || e)));
  }, []);

  if (err) return <div className="empty bad">接口调用失败：{err}</div>;

  return (
    <div className="stack">
      <div className="card">
        <div className="colhead">项目信息</div>
        <dl className="kv">
          <div className="kv-row">
            <dt>名称</dt>
            <dd className="mono">{boot?.app?.name || '—'}</dd>
          </div>
          <div className="kv-row">
            <dt>版本</dt>
            <dd className="mono">{boot?.app?.version || '—'}</dd>
          </div>
          <div className="kv-row">
            <dt>存储</dt>
            <dd className="mono nowrap">{boot?.storePath || '—'}</dd>
          </div>
          <div className="kv-row">
            <dt>默认路径</dt>
            <dd className="mono nowrap">{boot?.storeDefault || '—'}</dd>
          </div>
        </dl>
      </div>

      <div className="card">
        <div className="colhead">
          <span>CLI 命令与 HTTP 路由（同源）</span>
          <span className="tag">{routes ? routes.count : '…'} 条</span>
        </div>
        {(routes?.routes || []).map((r) => (
          <div key={r.id} className="row">
            <div className="name mono">{r.cli}</div>
            <div className="desc mono muted">{r.http || '(仅 CLI)'}</div>
            <div className="acts">
              <span className="tag">{r.module}</span>
            </div>
          </div>
        ))}
        {routes && !routes.routes.length && <div className="empty">暂无命令</div>}
        <CliHints module="home" />
      </div>
    </div>
  );
}
