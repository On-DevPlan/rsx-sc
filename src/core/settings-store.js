// 设置持久化：~/.rsx-sc/settings.json，原子写。
//
// 失败一律抛 NxError，让上层把它翻译成 5xx（外部依赖写不进磁盘 = INTERNAL）。

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { APP_DIR } from './paths.js';
import { badInput } from './errors/index.js';

const SETTINGS_PATH = join(APP_DIR, 'settings.json');

const DEFAULTS = {
  apiBase: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
  promptTemplate: 'You are an agent monitoring a screen. Describe what changed and what stands out. Be concise.',
  maxHistoryTurns: 10,
  temperature: 0.4,
  // history 不落盘：刷新页面即空，让对话清爽。
};

/**
 * @returns {Promise<{settings: object, source: 'defaults'|'disk', path: string, warning?: string}>}
 */
export async function readSettings() {
  try {
    await fsp.mkdir(APP_DIR, { recursive: true });
    const raw = await fsp.readFile(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const merged = mergeDefaults(parsed);
    return { settings: merged, source: 'disk', path: SETTINGS_PATH };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { settings: { ...DEFAULTS }, source: 'defaults', path: SETTINGS_PATH };
    }
    if (err instanceof SyntaxError) {
      return {
        settings: { ...DEFAULTS },
        source: 'disk',
        path: SETTINGS_PATH,
        warning: `settings.json 解析失败，已回退默认值: ${err.message}`,
      };
    }
    throw err;
  }
}

/**
 * Merge-写入。空 patch 仅返回当前 settings；非法字段抛 badInput。
 * @param {object} patch
 * @returns {Promise<{settings: object, path: string}>}
 */
export async function writeSettings(patch) {
  const cur = (await readSettings()).settings;
  const merged = mergeDefaults({ ...cur, ...(patch || {}) });

  if (typeof merged.apiBase !== 'string' || !merged.apiBase.trim()) {
    throw badInput('apiBase 必填且非空');
  }
  if (typeof merged.model !== 'string' || !merged.model.trim()) {
    throw badInput('model 必填且非空');
  }
  if (typeof merged.promptTemplate !== 'string' || !merged.promptTemplate.trim()) {
    throw badInput('promptTemplate 必填且非空');
  }
  if (typeof merged.maxHistoryTurns !== 'number' || merged.maxHistoryTurns < 1) {
    throw badInput('maxHistoryTurns 必须是正整数');
  }
  if (typeof merged.temperature !== 'number' || merged.temperature < 0 || merged.temperature > 2) {
    throw badInput('temperature 必须在 [0, 2]');
  }

  await fsp.mkdir(APP_DIR, { recursive: true });
  const tmp = SETTINGS_PATH + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(merged, null, 2), 'utf8');
  await fsp.rename(tmp, SETTINGS_PATH);
  return { settings: merged, path: SETTINGS_PATH };
}

function mergeDefaults(patched) {
  return {
    ...DEFAULTS,
    ...(patched || {}),
    // 不允许把 history 之类运行时状态落盘
  };
}