// home 域的 service：业务真相源。CLI 与 Web 面板共用这一层。
//
// 这是模板自带的最小示例域——它示范了 service 的三种返回形态：
//   throw        失败（调用方无从处理）
//   { status }   业务结果（调用方要拿它做决策）
//   普通对象     数据（调用方直接展示）
import { readFileSync } from 'node:fs';
import { APP_NAME, APP_DESC, APP_TITLE, STORE_PATH, storePathFromEnv } from '../../core/paths.js';

const VERSION = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
).version;

// 一次拿齐面板启动所需的上下文。
// 面板用它渲染标题、版本、存储路径与「CLI 等价」提示——
// 各视图不自己拼这些字符串，否则迟早与实际不符。
export async function bootstrap() {
  const { commandTable } = await import('./commands.js');
  return {
    app: { name: APP_NAME, title: APP_TITLE, description: APP_DESC, version: VERSION },
    storePath: storePathFromEnv(),
    storeDefault: STORE_PATH,
    commands: await commandTable(),
  };
}

// 大整数的可读化，供展示
export function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
