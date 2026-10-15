// capture 视图的展示组件：数字输入、对话气泡、转录裁剪。
// 从 view.jsx 拆出——eslint max-lines(300) 要求视图壳只留编排逻辑。
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

// 转录最多保留的气泡数（DOM 上限，防长会话卡顿）。
const MAX_TURNS = 200;

export function NumInput({ value, onChange, label, allowNegative = false }) {
  return (
    <label className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {label}
      <input
        type="number"
        min={allowNegative ? undefined : 0}
        className="input"
        style={{ width: 80 }}
        value={value}
        onChange={(e) => {
          const n = Math.floor(Number(e.target.value) || 0);
          onChange(allowNegative ? n : Math.max(0, n));
        }}
      />
    </label>
  );
}

export function BinCard({ bin }) {
  if (!bin) return null;
  if (!bin.supported) {
    return (
      <div className="empty bad">
        当前平台 {bin.platform}/{bin.arch} 不在 v1 支持范围（仅 Windows x64 与 Linux x64）。
      </div>
    );
  }
  if (!bin.found) {
    return (
      <div className="empty bad">
        未找到 rsx-sc-rust 二进制：{bin.reason}
        <div className="muted" style={{ marginTop: 6 }}>
          构建：<code>cd rust/rsx-sc-rust && cargo build --release</code>，把产物复制到
          <code>binaries/&lt;平台&gt;-&lt;架构&gt;/</code>
        </div>
        <CliHints module="capture" />
      </div>
    );
  }
  return (
    <div className="card">
      <div className="colhead">
        <span>二进制</span>
        <span className="tag">{bin.source}</span>
      </div>
      <div className="row">
        <div className="name">路径</div>
        <div className="desc mono nowrap">{bin.path}</div>
      </div>
      <div className="row">
        <div className="name">平台</div>
        <div className="desc mono">{bin.platform}/{bin.arch}</div>
      </div>
      <CliHints module="capture" />
    </div>
  );
}

export function Bubble({ turn }) {
  if (turn.role === 'frame') {
    const f = turn.payload;
    return (
      <div className="bubble in">
        <div className="bubble-meta">
          <span className="tag">frame #{f.seq}</span>
          <span className="muted">{(f.capturedAtMs ? new Date(f.capturedAtMs).toLocaleTimeString() : '')}</span>
        </div>
        <img
          alt={`frame ${f.seq}`}
          src={`data:image/png;base64,${f.pngB64}`}
          style={{ maxWidth: '100%', borderRadius: 6, marginTop: 6 }}
        />
        <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
          {f.width}×{f.height}
        </div>
      </div>
    );
  }
  if (turn.role === 'note') {
    return (
      <div className="bubble out">
        <div className="bubble-meta">
          <span className="tag">注解</span>
        </div>
        <div className="bubble-text">{turn.payload.content}</div>
      </div>
    );
  }
  return null;
}

export function trim(arr) {
  if (arr.length <= MAX_TURNS) return arr;
  return arr.slice(arr.length - MAX_TURNS);
}