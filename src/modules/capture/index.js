// capture 域：按区域持续截屏 + LLM 对话。
//
// 4 个 action：bin / start / stop / list。每个 action 都同时声明 cli + http。
import * as service from './service.js';

export default {
  id: 'capture',
  title: '截屏',
  order: 30,
  actions: [
    {
      id: 'capture.bin',
      cli: ['capture', 'bin'],
      http: ['GET', '/api/capture/bin'],
      summary: '解析 Rust 二进制路径与来源',
      run: () => service.bin(),
      render: (r) => {
        if (!r.supported) {
          return `✗ ${r.platform}/${r.arch} 未发布二进制（v1 仅支持 Windows x64 与 Linux x64）`;
        }
        return `${r.path}\n  来源: ${r.source}    平台: ${r.platform}/${r.arch}`;
      },
    },
    {
      id: 'capture.start',
      cli: ['capture', 'start'],
      http: ['POST', '/api/capture/start'],
      summary: '开始一个截屏会话',
      flags: {
        region: { type: 'string', default: '0,0,800,600' },
        intervalMs: { type: 'number', default: 500 },
        maxFrames: { type: 'number', default: null },
      },
      run: async (ctx) => {
        return service.start({
          region: ctx.region,
          intervalMs: ctx.intervalMs,
          maxFrames: ctx.maxFrames,
        });
      },
      render: (r) => `session: ${r.sessionId}\n  region=${JSON.stringify(r.region)}  intervalMs=${r.intervalMs}  maxFrames=${r.maxFrames ?? '∞'}`,
    },
    {
      id: 'capture.stop',
      cli: ['capture', 'stop'],
      http: ['POST', '/api/capture/stop'],
      summary: '停止一个截屏会话',
      flags: { sessionId: { type: 'string', required: true } },
      run: async (ctx) => service.stop({ sessionId: ctx.sessionId }),
      render: (r) => `已停止: ${r.sessionId} (${r.frames} 帧，${r.dropped} 丢失)`,
    },
    {
      id: 'capture.list',
      cli: ['capture', 'list'],
      http: ['GET', '/api/capture/sessions'],
      summary: '列出所有会话',
      run: () => service.list(),
      render: (r) => {
        if (!r.count) return '(无活跃会话)';
        const lines = [`${r.count} 个会话:`];
        for (const s of r.sessions) {
          lines.push(
            `  ${s.sessionId}  status=${s.status}  frames=${s.frames}  dropped=${s.dropped}  region=${JSON.stringify(s.region)}  intervalMs=${s.intervalMs}`
          );
        }
        return lines.join('\n');
      },
    },
  ],
};