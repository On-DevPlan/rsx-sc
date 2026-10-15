// settings 域：LLM 客户端配置 + 提示词模板的持久化。
import * as store from '../../core/settings-store.js';
import * as llm from '../../core/llm-client.js';

export default {
  id: 'settings',
  title: '设置',
  order: 5,
  actions: [
    {
      id: 'settings.get',
      cli: ['settings', 'get'],
      http: ['GET', '/api/settings'],
      summary: '读取 LLM 配置 + 提示词模板',
      run: async () => {
        const r = await store.readSettings();
        return { ...r, apiKey: maskKey(r.settings.apiKey) };
      },
      render: (r) => {
        const lines = [];
        lines.push(`来源: ${r.source}    路径: ${r.path}`);
        if (r.warning) lines.push(`警告: ${r.warning}`);
        lines.push(
          `apiBase:  ${r.settings.apiBase}`,
          `model:    ${r.settings.model}`,
          `apiKey:   ${maskKey(r.settings.apiKey)}`,
          `temperature: ${r.settings.temperature}`,
          `maxHistoryTurns: ${r.settings.maxHistoryTurns}`,
          '',
          '提示词模板:',
          r.settings.promptTemplate
        );
        return lines.join('\n');
      },
    },
    {
      id: 'settings.set',
      cli: ['settings', 'set'],
      http: ['POST', '/api/settings'],
      summary: '合并写入设置（任意字段可选）',
      flags: {
        apiBase: { type: 'string' },
        model: { type: 'string' },
        apiKey: { type: 'string' },
        promptTemplate: { type: 'string' },
        maxHistoryTurns: { type: 'number' },
        temperature: { type: 'number' },
      },
      run: async (ctx) => {
        const patch = {
          apiBase: ctx.apiBase,
          model: ctx.model,
          apiKey: ctx.apiKey,
          promptTemplate: ctx.promptTemplate,
          maxHistoryTurns: ctx.maxHistoryTurns,
          temperature: ctx.temperature,
        };
        // Drop undefined so we don't overwrite with nulls.
        for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
        const r = await store.writeSettings(patch);
        return { ...r, apiKey: maskKey(r.settings.apiKey) };
      },
      render: (r) => `已写入: ${r.path}`,
    },
    {
      id: 'settings.test',
      cli: ['settings', 'test'],
      http: ['POST', '/api/settings-test'],
      summary: '向 LLM 端点发一个小请求测试连通性',
      run: async () => {
        const r = await store.readSettings();
        const t0 = Date.now();
        try {
          // 不要设 maxTokens：推理模型（如 deepseek-v4.x）会先把预算花在思维链上，
          // 卡得太紧会导致 content 为空——表现为「模型明明通了却报返回空内容」。
          const out = await llm.chatCompletion({
            apiBase: r.settings.apiBase,
            apiKey: r.settings.apiKey,
            model: r.settings.model,
            messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
            temperature: 0,
          });
          return {
            status: 'ok',
            latencyMs: Date.now() - t0,
            model: r.settings.model,
            preview: String(out.content).slice(0, 80),
          };
        } catch (e) {
          // Re-throw so NxError mapping kicks in
          if (e && e.code) throw e;
          throw e;
        }
      },
      render: (r) =>
        r.status === 'ok'
          ? `✓ ${r.latencyMs}ms — ${r.preview}`
          : `✗ ${r.error}`,
    },
  ],
};

function maskKey(k) {
  if (!k) return '(未设置)';
  if (k.length <= 8) return '****';
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}