// 设置视图：LLM 客户端配置 + 提示词模板。
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useToast, useGuard } from '../../web/frontend/components/ui.jsx';

const DEFAULTS = {
  apiBase: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
  promptTemplate:
    'You are an agent monitoring a screen. Describe what changed and what stands out. Be concise.',
  maxHistoryTurns: 10,
  temperature: 0.4,
};

export default function SettingsView() {
  const toast = useToast();
  const guard = useGuard();
  const [form, setForm] = useState(DEFAULTS);
  const [origin, setOrigin] = useState(null);
  const [warning, setWarning] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api('/api/settings')
      .then((r) => {
        setForm({ ...DEFAULTS, ...r.settings });
        setOrigin({ source: r.source, path: r.path });
        setWarning(r.warning || '');
      })
      .catch((e) => setErr(String(e.message || e)));
  }, []);

  const update = useCallback((patch) => {
    setForm((f) => ({ ...f, ...patch }));
  }, []);

  const save = useCallback(async () => {
    const out = await guard(() =>
      api('/api/settings', { method: 'POST', body: form })
    );
    if (out) {
      setOrigin({ source: 'disk', path: out.path });
      setForm({ ...DEFAULTS, ...out.settings });
      toast('已保存');
    }
  }, [form, guard, toast]);

  const test = useCallback(async () => {
    setTestResult(null);
    try {
      const r = await api('/api/settings-test', { method: 'POST', body: form });
      setTestResult({ ok: true, ...r });
    } catch (e) {
      setTestResult({ ok: false, error: String(e.message || e), code: e.code });
    }
  }, [form]);

  if (err) return <div className="empty bad">读取设置失败：{err}</div>;

  return (
    <div className="stack">
      {warning ? <div className="empty bad">⚠ {warning}</div> : null}

      <div className="card">
        <div className="colhead">
          <span>LLM 接入（OpenAI 兼容）</span>
          {origin ? <span className="tag">{origin.source}</span> : null}
        </div>
        <Field label="API Base">
          <input
            className="input"
            value={form.apiBase}
            onChange={(e) => update({ apiBase: e.target.value })}
            spellCheck={false}
            placeholder="https://api.openai.com/v1"
          />
        </Field>
        <Field label="Model">
          <input
            className="input"
            value={form.model}
            onChange={(e) => update({ model: e.target.value })}
            spellCheck={false}
            placeholder="gpt-4o-mini"
          />
        </Field>
        <Field label="API Key（Ollama 等本地服务可留空）">
          <input
            className="input"
            type="password"
            value={form.apiKey}
            onChange={(e) => update({ apiKey: e.target.value })}
            spellCheck={false}
            placeholder="sk-..."
          />
        </Field>
        <Field label={`Temperature (${form.temperature})`}>
          <input
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={form.temperature}
            onChange={(e) => update({ temperature: Number(e.target.value) })}
          />
        </Field>
        <Field label={`历史轮数上限 (${form.maxHistoryTurns})`}>
          <input
            type="range"
            min={4}
            max={20}
            step={1}
            value={form.maxHistoryTurns}
            onChange={(e) => update({ maxHistoryTurns: Number(e.target.value) })}
          />
        </Field>
        <Field label="提示词模板">
          <textarea
            className="input"
            rows={6}
            value={form.promptTemplate}
            onChange={(e) => update({ promptTemplate: e.target.value })}
            spellCheck={false}
          />
        </Field>
        <div className="row">
          <div className="desc muted">
            {origin?.path ? `保存到：${origin.path}` : ''}
          </div>
          <div className="acts">
            <button className="btn ghost" onClick={test}>测试连通</button>
            <button className="btn" onClick={save}>保存</button>
          </div>
        </div>
        {testResult ? (
          <div className={'empty ' + (testResult.ok ? 'ok' : 'bad')}>
            {testResult.ok
              ? `✓ ${testResult.latencyMs}ms — ${testResult.preview}`
              : `✗ ${testResult.error}${testResult.code ? ' (' + testResult.code + ')' : ''}`}
          </div>
        ) : null}
        <CliHints module="settings" />
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="name">{label}</div>
      <div className="desc" style={{ flex: 1 }}>{children}</div>
    </div>
  );
}