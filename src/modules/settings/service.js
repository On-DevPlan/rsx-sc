// settings service：被 web 视图与外部 agent 调用的稳定入口。
export * from './index.js';
export { readSettings, writeSettings } from '../../core/settings-store.js';
export { chatCompletion, buildVisionMessages, isValidBase } from '../../core/llm-client.js';