// LLM 客户端：OpenAI 兼容的 chat completions。
//
// 全部走 POST /chat/completions（非流式）。流式在 SSE 之上再嵌一层 ReadableStream
// 会让多模态消息构造变复杂，v1 不实现。
//
// 错误一律抛 `NxError(EXTERNAL, ...)`，把响应体塞进 details 给调用方排错。

import { external, badInput } from './errors/index.js';

const DEFAULT_TIMEOUT_MS = 60000;

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
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
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
      throw external('LLM 请求超时', { url });
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