// capture 视图：区域 + 间隔 + LLM 对话气泡。
import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useToast } from '../../web/frontend/components/ui.jsx';
import { NumInput, BinCard, Bubble, trim } from './parts.jsx';

export default function CaptureView() {
  const toast = useToast();
  const [bin, setBin] = useState(null);
  const [region, setRegion] = useState({ x: 0, y: 0, w: 800, h: 600 });
  const [minIntervalMs, setMinIntervalMs] = useState(0);
  const [maxFrames, setMaxFrames] = useState('');
  const [sessionId, setSessionId] = useState(null);
  const [stats, setStats] = useState(null);
  const [picking, setPicking] = useState(false);
  // 采集已结束但流还开着——等最后一次 LLM 回复落地。
  const [ended, setEnded] = useState(false);
  const idleTimerRef = useRef(null);
  const [turns, setTurns] = useState([]); // {role, payload, ts}
  const [note, setNote] = useState('');
  const esRef = useRef(null);
  const seenRef = useRef(new Set()); // dedupe by frame.seq

  // Resolve binary path on mount.
  useEffect(() => {
    api('/api/capture/bin')
      .then(setBin)
      .catch((e) => toast(String(e.message || e)));
  }, [toast]);

  // Poll session list while a session is active.
  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await api('/api/capture/sessions');
        const s = (r.sessions || []).find((x) => x.sessionId === sessionId);
        if (!cancelled && s) setStats(s);
      } catch {}
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId]);

  // Open SSE stream when session becomes active; close on stop / unmount.
  useEffect(() => {
    if (!sessionId) return undefined;
    seenRef.current.clear();
    const url = `/api/capture/stream/${encodeURIComponent(sessionId)}`;
    const es = new EventSource(url);
    esRef.current = es;
    const closeStream = () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
      try { es.close(); } catch {}
      esRef.current = null;
      setEnded(false);
      setSessionId(null);
    };
    // 看门狗：采集结束后流不立刻关（最后一次 LLM 回复可能还在路上），
    // 改成「多久没新事件就关」。采集进行中帧不断，看门狗永远不触发。
    const armIdleClose = () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(closeStream, 30000);
    };
    es.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      armIdleClose();
      if (msg.type === 'frame') {
        if (seenRef.current.has(msg.seq)) return;
        seenRef.current.add(msg.seq);
        setTurns((t) => trim([...t, { role: 'frame', payload: msg, ts: Date.now() }]));
      } else if (msg.type === 'llm_start') {
        // 先立一个空气泡，随后的 delta 往里追加 —— 用户立刻看到「在回复」
        setTurns((t) =>
          trim([...t, { role: 'assistant', payload: { seq: msg.seq, content: '', done: false }, ts: Date.now() }])
        );
      } else if (msg.type === 'llm_delta') {
        setTurns((t) =>
          t.map((x) =>
            x.role === 'assistant' && x.payload.seq === msg.seq && !x.payload.done
              ? { ...x, payload: { ...x.payload, content: x.payload.content + msg.text } }
              : x
          )
        );
      } else if (msg.type === 'llm_end') {
        // 以完整文本为准（流式增量可能因断线丢尾）
        setTurns((t) =>
          t.map((x) =>
            x.role === 'assistant' && x.payload.seq === msg.seq
              ? { ...x, payload: { seq: msg.seq, content: msg.content, done: true } }
              : x
          )
        );
      } else if (msg.type === 'llm_error') {
        setTurns((t) =>
          trim([
            ...t,
            { role: 'llm_error', payload: { seq: msg.seq, error: msg.error, code: msg.code }, ts: Date.now() },
          ])
        );
      } else if (msg.type === 'status') {
        setStats((s) =>
          s
            ? { ...s, frames: msg.frames_emitted ?? s.frames, dropped: msg.dropped_total ?? s.dropped }
            : s
        );
      } else if (msg.type === 'complete') {
        setStats((s) => (s ? { ...s, frames: msg.frames ?? s.frames, dropped: msg.dropped ?? s.dropped, status: 'ended' } : s));
        toast(`循环结束：${msg.frames} 帧，丢失 ${msg.dropped}`);
      } else if (msg.type === 'end') {
        // 采集结束，但可能还有一次 LLM 回复在路上 → 不关流，交给看门狗。
        setEnded(true);
      } else if (msg.type === 'close') {
        closeStream();
      } else if (msg.type === 'error') {
        toast(`错误: ${msg.message}`);
      }
    };
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
      try { es.close(); } catch {}
      esRef.current = null;
    };
  }, [sessionId, toast]);

  // 原生框选：蒙版铺满所有显示器，可以跨屏拖拽。
  // timeoutMs 必须大于服务端 5 分钟兜底，让服务端的超时错误先到。
  const pick = useCallback(async () => {
    setPicking(true);
    try {
      const r = await api('/api/capture/select', { method: 'POST', body: {}, timeoutMs: 330000 });
      if (r.status === 'cancelled') {
        toast('已取消框选');
        return;
      }
      setRegion({ x: r.region.x, y: r.region.y, w: r.region.width, h: r.region.height });
      toast(`已框选 ${r.region.width}×${r.region.height}`);
    } catch (e) {
      toast(String(e.message || e));
    } finally {
      setPicking(false);
    }
  }, [toast]);

  const start = useCallback(async () => {
    try {
      const out = await api('/api/capture/start', {
        method: 'POST',
        body: {
          region: `${region.x},${region.y},${region.w},${region.h}`,
          minIntervalMs,
          maxFrames: maxFrames ? Number(maxFrames) : null,
        },
      });
      setTurns([]);
      setStats({ ...out, status: 'running', frames: 0, dropped: 0 });
      setSessionId(out.sessionId);
      setEnded(false);
      toast('已开始');
    } catch (e) {
      toast(String(e.message || e));
    }
  }, [region, minIntervalMs, maxFrames, toast]);

  const stop = useCallback(async () => {
    if (!sessionId) return;
    try {
      await api('/api/capture/stop', { method: 'POST', body: { sessionId } });
      // 不立刻关流：停止同样可能还有一次回复在路上，交给看门狗收尾
      setEnded(true);
    } catch (e) {
      toast(String(e.message || e));
    }
  }, [sessionId, toast]);

  const sendNote = useCallback(() => {
    if (!note.trim()) return;
    setTurns((t) => trim([...t, { role: 'note', payload: { content: note.trim() }, ts: Date.now() }]));
    setNote('');
  }, [note]);

  return (
    <div className="stack">
      <BinCard bin={bin} />

      <div className="card">
        <div className="colhead">
          <span>截屏参数</span>
          {stats ? <span className="tag">{stats.status}</span> : null}
        </div>
        <div className="row">
          <div className="name">区域 (x,y,w,h)</div>
          <div className="desc" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <NumInput value={region.x} onChange={(v) => setRegion((r) => ({ ...r, x: v }))} label="x" allowNegative />
            <NumInput value={region.y} onChange={(v) => setRegion((r) => ({ ...r, y: v }))} label="y" allowNegative />
            <NumInput value={region.w} onChange={(v) => setRegion((r) => ({ ...r, w: v }))} label="w" />
            <NumInput value={region.h} onChange={(v) => setRegion((r) => ({ ...r, h: v }))} label="h" />
            <button
              className="btn ghost"
              onClick={pick}
              disabled={!bin?.found || picking || (!!sessionId && !ended)}
              title="弹出原生蒙版（铺满所有显示器，可跨屏拖拽）；Esc 或右键取消"
            >
              {picking ? '等待框选…' : '框选区域'}
            </button>
          </div>
        </div>
        <div className="row">
          <div className="name">最小间隔 (ms)</div>
          <div className="desc">
            <input
              type="number"
              min={0}
              step={50}
              className="input"
              style={{ width: 120 }}
              value={minIntervalMs}
              onChange={(e) => setMinIntervalMs(Math.max(0, Number(e.target.value) || 0))}
            />
            <span className="muted" style={{ marginLeft: 8 }}>
              只是兜底；实际节奏是「等这一帧的模型回复落地，再截下一张」
            </span>
          </div>
        </div>
        <div className="row">
          <div className="name">最大帧数</div>
          <div className="desc">
            <input
              type="number"
              min={1}
              className="input"
              style={{ width: 120 }}
              placeholder="∞"
              value={maxFrames}
              onChange={(e) => setMaxFrames(e.target.value)}
            />
            <span className="muted" style={{ marginLeft: 8 }}>留空 = 一直跑到停止</span>
          </div>
        </div>
        <div className="row">
          <div className="desc muted">
            {stats
              ? `已捕获 ${stats.frames} 帧 · 丢失 ${stats.dropped} 帧 · session ${stats.sessionId?.slice(0, 8)}…${ended ? ' · 采集已结束，等待最后一条回复…' : ''}`
              : '未启动'}
          </div>
          <div className="acts">
            {sessionId && !ended ? (
              <button className="btn danger" onClick={stop}>停止</button>
            ) : (
              <button className="btn" onClick={start} disabled={!bin?.found}>开始</button>
            )}
          </div>
        </div>
        <CliHints module="capture" />
      </div>

      <div className="card">
        <div className="colhead">
          <span>对话记录</span>
          <span className="tag">{turns.length}</span>
        </div>
        <div className="chat">
          {turns.map((t, i) => (
            <Bubble key={i} turn={t} />
          ))}
          {!turns.length ? (
            <div className="empty">开始截屏后，每帧会作为「收到」气泡出现在这里；同时 LLM 会按提示词模板回复（需先在「设置」页配置）。</div>
          ) : null}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <input
            className="input"
            placeholder="记一笔（可选，按 Enter 发送）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') sendNote();
            }}
          />
          <button className="btn ghost" onClick={sendNote}>发送</button>
        </div>
      </div>
    </div>
  );
}


