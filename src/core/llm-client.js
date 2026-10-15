// LLM 客户端：OpenAI 兼容的 chat completions。
//
// 全部走 POST /chat/completions（非流式）。流式在 SSE 之上再嵌一层 ReadableStream
// 会让多模态消息构造变复杂，v1 不实现。
//
// 错误一律抛 `NxError(EXTERNAL, ...)`，把响应体塞进 details 给调用方排错。

import { external, badInput } from './errors/index.js';

// 单次请求超时。给得比较宽：目标模型常是推理模型，一次多模态调用要先把
// 思维链跑完，实测几十秒很正常。这里不做成配置项——真正需要长等待的用户
// 会立刻在面板上看到「请求超时」，那时再调这个常量比多一个设置项更直接。
const DEFAULT_TIMEOUT_MS = 180000;

/**
 * @param {{
 *   apiBase: string,
 *   apiKey: string,
 *   model: string,
 *   messages: Array<{role: string, content: any}>,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   maxTokens?: number,
 *   temperature?: number,
 * }} opts
 * @returns {Promise<{content: string, usage?: object, raw: object}>}
 */
export async function chatCompletion(opts) {
  if (!opts || !opts.apiBase) throw badInput('apiBase 不能为空');
  if (!opts.model) throw badInput('model 不能为空');
  if (!Array.isArray(opts.messages) || !opts.messages.length) {
    throw badInput('messages 不能为空');
  }

  const url = joinUrl(opts.apiBase, '/chat/completions');
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: false,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') {
      if (timedOut) throw external('LLM 请求超时', { url });
      throw e; // 调用方取消
    }
    throw external('LLM 请求失败', { url, reason: String(e && (e.message || e)) });
  }
  clearTimeout(timer);

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    throw external(`LLM ${res.status}: ${summarizeError(body)}`, {
      url,
      status: res.status,
      response: body,
    });
  }

  const choice = body.choices && body.choices[0];
  const content = choice?.message?.content ?? '';
  if (!content) {
    throw external('LLM 返回空内容', { url, status: res.status, response: body });
  }
  return { content, usage: body.usage, raw: body };
}

function summarizeError(body) {
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (body.error && typeof body.error === 'object') {
    return body.error.message || JSON.stringify(body.error);
  }
  if (body.error) return String(body.error);
  return '';
}

/**
 * 流式版：POST 同一个 /chat/completions，但 `stream: true`，把 delta 逐块
 * 交给 `onDelta` 回调，返回完整文本。
 *
 * 为什么要流式：目标模型常是推理模型，一次多模态调用要先把思维链跑完才吐
 * 正文，整段等下来几十秒。流式让面板能边收边显示，而不是长时间白屏。
 * （推理内容走 delta.reasoning_content，这里不显示——用户关心的是结论。）
 *
 * @param {{apiBase, apiKey, model, messages, signal?, timeoutMs?, temperature?, onDelta?: (t: string) => void}} opts
 * @returns {Promise<{content: string}>}
 */
export async function chatCompletionStream(opts) {
  if (!opts || !opts.apiBase) throw badInput('apiBase 不能为空');
  if (!opts.model) throw badInput('model 不能为空');
  if (!Array.isArray(opts.messages) || !opts.messages.length) {
    throw badInput('messages 不能为空');
  }

  const url = joinUrl(opts.apiBase, '/chat/completions');
  const ctrl = new AbortController();
  // 区分「我们自己的超时」与「调用方取消」：两者都表现为 AbortError，
  // 但语义完全不同——把调用方取消报成「请求超时」会让人去查网络。
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw external('LLM 请求超时', { url });
    throw external('LLM 请求失败', { url, reason: String(e && (e.message || e)) });
  }

  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    throw external(`LLM ${res.status}: ${summarizeError(body)}`, {
      url,
      status: res.status,
      response: body,
    });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  let done = false;

  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });

      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue; // 忽略注释行 / 空行 / event: 行
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          done = true;
          break;
        }
        let j;
        try {
          j = JSON.parse(payload);
        } catch {
          continue; // 半个包 / 非 JSON 的保活帧
        }
        const delta = j.choices && j.choices[0] && j.choices[0].delta;
        // 只取正文；delta.reasoning_content 是思维链，不展示
        const text = delta && delta.content;
        if (text) {
          full += text;
          if (opts.onDelta) opts.onDelta(text);
        }
      }
    }
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') {
      if (timedOut) throw external('LLM 请求超时', { url });
      if (!full) throw e; // 调用方取消且还没收到内容 —— 原样上抛，上层按取消处理
      return { content: full }; // 已收到部分内容：当作正常结束，别丢掉
    }
    throw external('LLM 流读取失败', { url, reason: String(e && (e.message || e)) });
  }
  clearTimeout(timer);

  if (!full) throw external('LLM 返回空内容', { url, status: res.status });
  return { content: full };
}

function joinUrl(base, path) {
  if (!base.endsWith('/') && !path.startsWith('/')) return base + '/' + path;
  if (base.endsWith('/') && path.startsWith('/')) return base + path.slice(1);
  return base + path;
}

/**
 * Build the OpenAI-style multimodal messages array for one round-trip.
 *
 * Layout:
 *   - system: promptTemplate (only on the FIRST round; subsequent rounds use
 *     user/assistant history to keep the system prompt in context)
 *   - history: last K turns of {role, content}, where each assistant content
 *     is plain text and each user content is plain text.
 *   - last user message: text + image_url (base64 PNG).
 *
 * @param {{
 *   promptTemplate: string,
 *   history: Array<{role: 'user'|'assistant', content: string}>,
 *   framePngB64: string,
 *   frameMeta?: {seq?: number, capturedAtMs?: number, width?: number, height?: number},
 *   isFirstRound?: boolean,
 * }} opts
 * @returns {Array<{role: string, content: any}>}
 */
export function buildVisionMessages(opts) {
  const messages = [];
  if (opts.isFirstRound !== false) {
    messages.push({
      role: 'system',
      content: String(opts.promptTemplate || 'You are an agent observing a screen.'),
    });
  }
  for (const turn of opts.history || []) {
    if (!turn || !turn.role) continue;
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;
    messages.push({ role: turn.role, content: String(turn.content ?? '') });
  }
  const textParts = [];
  textParts.push(String(opts.promptTemplate || 'Describe what is on this screen.'));
  if (opts.frameMeta && typeof opts.frameMeta.seq === 'number') {
    textParts.push(`[frame #${opts.frameMeta.seq}]`);
  }
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: textParts.join(' ') },
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${opts.framePngB64}` },
      },
    ],
  });
  return messages;
}

export function isValidBase(s) {
  if (!s || typeof s !== 'string') return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}