// 通用 CLI 运行器：解析 argv → 匹配 action → 校验 → 执行 → 渲染。
//
// 改造前这里是一个 400 行的 switch，每条命令要在 BOOL_FLAGS / helpText / case /
// renderXxx 四处重复登记。现在命令表、help 文本、参数校验全部由 action 声明派生，
// 新增命令只需在所属模块的 actions 里加一条。
import { readFileSync } from 'node:fs';
import { APP_NAME, APP_TITLE, APP_DESC, DEFAULT_PORT, STORE_ENV, storePathFromEnv } from '../core/paths.js';
import { toErrorPayload, exitCodeOf, badInput } from '../core/errors/index.js';
import { ACTIONS, MODULES } from './registry.js';
import { cliPathsOf, argSpecsOf, flagSpecsOf, booleanFlagNames, applySpec, usageOf } from './spec.js';

const VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
).version;

// ---- 平台命令：不属于任何功能域，不参与 action 表 ----
// 用与 action 相同的形状声明，好让参数解析与 help 生成保持同一套逻辑。
const BUILTINS = [
  {
    id: 'serve',
    cli: ['serve'],
    summary: '启动 Web 面板',
    flags: { port: { type: 'number', default: DEFAULT_PORT }, 'no-open': { type: 'boolean' } },
    run: (ctx) => cmdServe(ctx),
  },
  {
    id: 'help',
    cli: ['help'],
    summary: '显示帮助（可跟模块名或命令组，如 nx-nx help repo',
    args: [{ name: 'topic', required: false }],
    // 走标准 action 形态：--json 时 emit 会序列化返回的条目，
    // 于是 `help --json` 输出的是可解析的命令表而非帮助文本
    run: (ctx) => helpEntries(ctx.topic),
    render: (entries, ctx) => renderHelp(entries, ctx.topic),
  },
  // render 让 `nx-nx version` 输出裸版本号（脚本里可 `V=$(nx-nx version)`），
  // 而 `--json` 仍走序列化，保持机器可读
  { id: 'version', cli: ['version'], summary: '显示版本', run: () => VERSION, render: (v) => v },
];

export const ALL_COMMANDS = [...BUILTINS, ...ACTIONS];

// ---- 参数解析 ----

// 全局 flag 先摘掉：它们可以出现在 argv 任意位置，不属于任何 action 的声明。
function splitGlobals(argv) {
  const rest = [];
  let json = false;
  let store;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { json = true; continue; }
    if (a === '--store') { store = argv[++i]; continue; }
    if (a.startsWith('--store=')) { store = a.slice('--store='.length); continue; }
    rest.push(a);
  }
  return { rest, json, store };
}

// 匹配命令：把声明路径与 argv 前缀逐 token 比较，选最长匹配。
//
// 逐 token 比较（而非只取「开头连续的非 flag token」）是必需的——有些命令路径
// 本身就含 flag，例如 `skill install --list` 是「列出内置包」而非「安装」。
// 最长优先则让 ['skill','central','add'] 压过 ['skill','central']，子命令与别名因此共存。
export function resolveCommand(argv) {
  let best = null;
  let bestLen = -1;
  for (const cmd of ALL_COMMANDS) {
    for (const path of cliPathsOf(cmd)) {
      if (path.length > argv.length || path.length <= bestLen) continue;
      if (path.every((seg, i) => seg === argv[i])) {
        best = { cmd, path };
        bestLen = path.length;
      }
    }
  }
  return best ? { ...best, rest: argv.slice(bestLen) } : null;
}

// 解析剩余 token。布尔 flag 不吞下一个 token —— 否则 `skill install --force demo`
// 会把 force 解析成字符串 'demo'，而 demo 本该是位置参数。
function parseRest(rest, cmd) {
  const bools = booleanFlagNames(cmd);
  const positionals = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { positionals.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 2) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = rest[i + 1];
    if (!bools.has(key) && next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { positionals, flags };
}

// 位置参数按声明顺序映射成具名输入；末尾声明 { rest: true } 的收集剩余全部
function mapPositionals(positionals, argSpecs) {
  const out = {};
  let i = 0;
  for (const spec of argSpecs) {
    if (spec.rest) { out[spec.name] = positionals.slice(i); i = positionals.length; break; }
    if (positionals[i] !== undefined) out[spec.name] = positionals[i];
    i++;
  }
  if (i < positionals.length) {
    throw badInput(`多余的参数: ${positionals.slice(i).join(' ')}（用法见 ${APP_NAME} help）`);
  }
  return out;
}

// 未知 flag 直接报错——`--fiile` 这类拼写错误应该立刻被指出来，而不是被静默忽略
function assertKnownFlags(flags, cmd) {
  const known = new Set(flagSpecsOf(cmd).map((f) => f.name));
  for (const k of Object.keys(flags)) {
    if (!known.has(k)) throw badInput(`未知参数 --${k}（用法见 ${APP_NAME} help）`);
  }
}

// ---- 输出 ----

// render 拿到 (data, ctx)，可以是 async——有些渲染需要补一点上下文才能标注
// （例如候选清单要标出哪一项是「当前」），而 `--json` 必须保持纯数据的旧形状。
async function emit(cmd, data, json, ctx) {
  // 无返回值的命令（help / serve 这类）不该打印任何东西：落进 JSON.stringify(undefined)
  // 会打出字面量 "undefined"，让 `help --json` 的 stdout 不再是合法 JSON。
  if (data === undefined && !cmd.render) return;

  if (json) {
    if (data === undefined) return;
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (cmd.render) {
    const text = await cmd.render(data, ctx);
    if (text !== undefined && text !== null && text !== '') console.log(text);
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

// 失败一律 exit 1；--json 下输出可解析的错误对象。
// 注意 error 保持字符串（历史契约），code 是新增字段——agent 可据此分支，
// 老消费方按字符串匹配「用法:」「未设置」「不存在」仍然可用。
function fail(err, json) {
  const p = toErrorPayload(err);
  if (json) {
    const payload = { ok: false, error: p.message, code: p.code };
    if (p.details !== undefined) payload.details = p.details;
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.error('错误: ' + p.message);
  }
  process.exitCode = exitCodeOf(p.code);
}

// ---- help：完全由命令表生成 ----

// 命令表的一行。`routes` 与 `help` 共用它，因此两张表必然同源同长——
// 面板底部的「CLI 等价」提示用的也是这个形状（经 bootstrap 下发）。
export function commandEntry(c) {
  return {
    id: c.id,
    module: c.module || 'platform',
    command: APP_NAME + ' ' + cliPathsOf(c)[0].join(' '),
    usage: usageOf(c),
    http: c.http ? { method: c.http[0], path: c.http[1] } : null,
    summary: c.summary,
  };
}

// 解析帮助主题。既接受模块 id（repos），也接受命令组（repo）——
// 用户脑子里想的是「repo 相关的东西」，不会去记内部模块名。
// 这条路径不能报错退出：`nx-nx help <随便什么>` 失败会让最需要帮助的人卡住。
function helpEntries(topic) {
  const all = ALL_COMMANDS.map(commandEntry);
  if (!topic) return all;

  const t = String(topic);
  if (MODULES.some((m) => m.id === t)) return all.filter((e) => e.module === t);

  const byRoot = all.filter((e) => e.command.split(' ')[1] === t);
  if (byRoot.length) return byRoot;

  // 命令本身的 id 也认（如 `nx-nx help repo.add`）
  const byId = all.filter((e) => e.id === t);
  if (byId.length) return byId;

  // 命令组名由已注册的命令表现推，不写死——模块增删（如 gh 的移除）时提示自动跟上。
  // all 里是 commandEntry（已拍平，没有原始 cli 字段），所以从 command 串里取首词，
  // 且只收「有多条命令的根词」——那才是命令组，单个的（serve/health）列出来没意义。
  const roots = all.map((e) => e.command.slice(APP_NAME.length + 1).split(/\s+/)[0]);
  const groups = [...new Set(roots.filter((r) => roots.filter((x) => x === r).length > 1))]
    .slice(0, 4)
    .join(' / ');
  const topics = [...new Set(all.map((e) => e.module))].join(', ');
  throw badInput(`未知帮助主题: ${t}（可用模块: ${topics}；或命令组如 ${groups}）`);
}

function renderHelp(entries, topic) {
  const lines = [];
  if (!topic) {
    lines.push(`${APP_NAME} · ${APP_TITLE} v${VERSION}`);
    lines.push(APP_DESC + '。CLI 与 Web 面板共享同一 action 声明。');
    lines.push(`存储: ${storePathFromEnv()}    （环境变量 ${STORE_ENV} 或 --store 覆盖）`);
    lines.push('');
  }

  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.module)) groups.set(e.module, []);
    groups.get(e.module).push(e);
  }

  for (const [mod, list] of groups) {
    const title =
      MODULES.find((m) => m.id === mod)?.title || (mod === 'platform' ? '平台命令' : mod);
    lines.push(title + ':');
    const width = Math.max(...list.map((e) => e.usage.length));
    for (const e of list) lines.push('  ' + e.usage.padEnd(width + 2) + e.summary);
    lines.push('');
  }

  lines.push('通用:');
  lines.push('  --json    机器可读输出（agent 模式）');
  lines.push('  --store   本次运行覆盖存储路径');
  return lines.join('\n');
}

// `nx-nx <命令> --help`：只打印这一条，而不是整个模块——
// 之前这里传的是 cmd.cli[0]，对别名 action（cli 是数组的数组）会拼出 "bundled,list"。
function printCommandHelp(cmd) {
  const lines = [usageOf(cmd)];
  if (cmd.summary) lines.push('    ' + cmd.summary);
  lines.push('');

  const aliases = cliPathsOf(cmd).slice(1).map((p) => APP_NAME + ' ' + p.join(' '));
  if (aliases.length) lines.push('别名: ' + aliases.join('  ·  '));
  if (cmd.http) lines.push('对应路由: ' + cmd.http[0] + ' ' + cmd.http[1]);
  lines.push('所属模块: ' + (cmd.module || 'platform'));
  console.log(lines.join('\n'));
}

async function cmdServe(ctx) {
  const { startServer } = await import('./server.js');
  const { openBrowser } = await import('../core/open.js');
  const port = ctx.port || DEFAULT_PORT;
  const server = await startServer({ port, host: '127.0.0.1' });
  const addr = `http://127.0.0.1:${server.address().port}`;

  console.log(APP_NAME + ' · ' + APP_TITLE + ' v' + VERSION);
  console.log(`面板:   ${addr}`);
  console.log(`存储:   ${storePathFromEnv()}`);
  console.log('CLI:    ' + APP_NAME + ' help（每个按钮都有对应命令，agent 可加 --json）');
  console.log('按 Ctrl+C 停止');

  if (!ctx['no-open']) openBrowser(addr);

  const shutdown = () => {
    console.log('\n正在停止...');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ---- 主入口 ----

export async function runCli(argv) {
  const { rest, json, store } = splitGlobals(argv);
  if (store) process.env[STORE_ENV] = store;

  const hit = resolveCommand(rest);

  // 无参数、或只有全局 flag：显示帮助（与历史行为一致，退出码 0）
  if (!hit) {
    if (!rest.length) { console.log(renderHelp(helpEntries(), '')); return; }
    console.error(`未知命令: ${rest.join(' ')}`);
    console.error('运行 ' + APP_NAME + ' help 查看用法');
    process.exitCode = 1;
    return;
  }

  const { cmd, rest: tail } = hit;

  try {
    if (tail.includes('--help')) { printCommandHelp(cmd); return; }

    const { positionals, flags } = parseRest(tail, cmd);
    assertKnownFlags(flags, cmd);
    const input = { ...mapPositionals(positionals, argSpecsOf(cmd)), ...flags };
    const ctx = applySpec(cmd, input);
    const data = await cmd.run(ctx, { transport: 'cli' });
    await emit(cmd, data, json, ctx);
  } catch (err) {
    fail(err, json);
  }
}
