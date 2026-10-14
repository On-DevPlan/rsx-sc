// 本地开发 shim：把全局 `rsx-sc` 指向本仓库，改完代码立刻生效，不用发版。
//
// 为什么要脚本而不是让人手敲 `npm link`：
//   Windows 上 npm link 会在 npm 全局 prefix 下建一个 cmd shim，而这个 prefix
//   不一定在用户真实 PATH 上（WorkBuddy 注入的 PATH 与注册表那份不同）——
//   link 完 `rsx-sc` 在用户自己的终端里仍然 command not found，而且没人会注意到。
//   脚本把这件事显式化：先探测现状，再选一条能真正生效的路子。
//
// 覆盖式 shim（默认）：
//   用户敲 `rsx-sc` 解析到的真实落点（比如 volta\bin\rsx-sc.cmd）本来就在 PATH 上，
//   把那里的启动器备份后原地替换成转发器。PATH 一字不动，已开着的终端立即生效；
//   volta / npm / pnpm 管的文本 shim 一视同仁，跟包管理器无关。
//   覆盖唯一的病根风险是「原件丢了」——覆盖前把原内容逐字节存进安装清单（RECEIPT），
//   unlink 时原样写回。
// volta 模式（--mode=volta）：pnpm pack → volta install，快照式，改码后要重跑。
//
// 默认直接动手（覆盖 + 备份足够安全，dry-run 反而挡路；--dry-run 才只预览）；
// --unlink 按清单还原。build 链路用 --auto：只覆盖现成落点，绝不新建目录 / 改 PATH
//（CI、全新机器上跑 build 都安全），失败也不拖垮 build。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, rmdirSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, basename } from 'node:path';

const ROOT = dirname0(import.meta.url).replace(/[\\/]scripts$/, '');
const IS_WIN = process.platform === 'win32';

const argv = process.argv.slice(2);
const unlink = argv.includes('--unlink');
const auto = argv.includes('--auto'); // build 链路：只覆盖现成落点，不兜底、不动 PATH，尽力而为
const dryRun = argv.includes('--dry-run') || argv.includes('-n');
const yes = !dryRun; // 默认动手；--yes 仍被接受（旧习惯），已无实际作用
const modeArg = argv.find((a) => a.startsWith('--mode='))?.slice(7);

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function dirname0(url) {
  return new URL('.', url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false, ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), error: r.error };
}

// 路径等同性比较：分隔符归一 + Windows 下大小写不敏感。
// 用于「用户 PATH 里是否已有该目录」这类判断——PATH 条目与目标目录的写法没法保证一致。
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => p.replace(/[/\\]+$/, '').replace(/[/\\]/g, '/');
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

// ─── 现状探测 ──────────────────────────────────────────────────────

function detect() {
  // 不用 `where`/`which`：解析输出在不同 shell 下格式不一。
  // 更可靠的是直接看 PATH 上的候选目录里有没有 rsx-sc 可执行文件。
  const exts = IS_WIN ? ['.cmd', '.exe', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean);
  const paths = [];
  for (const d of dirs) {
    for (const ext of exts) {
      const f = join(d, 'rsx-sc' + ext);
      if (existsSync(f)) { paths.push(f); break; }
    }
  }
  const isLocal = paths.some((p) => {
    if (p.includes(ROOT)) return true;
    try { return readFileSync(p, 'utf8').includes(ROOT); } catch { return false; }
  });

  // volta 的 bin 目录
  const voltaBin = findVoltaBin();
  const hasVolta = !!voltaBin;

  // volta 装的那份包在哪儿（VOLTA_HOME 自定义用户也要能找到）
  const voltaHome = process.env.VOLTA_HOME
    || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Volta') : null);
  const voltaPkg = voltaHome
    ? join(voltaHome, 'tools', 'image', 'packages', pkg.name, 'node_modules', pkg.name, 'package.json')
    : null;
  const voltaVersion = voltaPkg && existsSync(voltaPkg)
    ? JSON.parse(readFileSync(voltaPkg, 'utf8')).version
    : null;

  return { paths, isLocal, voltaBin, hasVolta, voltaVersion };
}

// volta bin 定位：先 PATH 上找（认得准），再按 VOLTA_HOME / LOCALAPPDATA 推导。
// 无论是哪个来源，都要校验目录里有 volta 特征文件（*.cmd 含 "volta run"），
// 防止把用户 PATH 上恰好叫 Volta\bin 的无关目录当成真的。
function findVoltaBin() {
  const candidates = [];
  const dirs = (process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean);
  for (const d of dirs) {
    if (/Volta[/\\]bin$/i.test(d)) candidates.push(d);
  }
  if (process.env.VOLTA_HOME) candidates.push(join(process.env.VOLTA_HOME, 'bin'));
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Volta', 'bin'));

  for (const d of candidates) {
    if (!existsSync(d)) continue;
    // 校验 volta 特征：目录里任一 .cmd 含 "volta run"（volta 生成的 shim 格式）
    try {
      const files = readdirSync(d).filter((f) => f.endsWith('.cmd')).slice(0, 30);
      for (const f of files) {
        if (readFileSync(join(d, f), 'utf8').includes('volta run')) return d;
      }
    } catch { /* 读不动就换下一个候选 */ }
  }
  return null;
}

// ─── 安装清单（RECEIPT）：unlink 的唯一依据 ────────────────────────
//
// v2 格式：originals 记录每个被改文件的原始内容（null = 原本不存在，unlink 时删除）。

function receiptPath() {
  return join(devDir(), 'install.json');
}

function readReceipt() {
  try {
    const r = JSON.parse(readFileSync(receiptPath(), 'utf8'));
    const v2 = r && r.version === 2 && r.originals && typeof r.originals === 'object';
    return v2 ? r : null;
  } catch { return null; }
}

function writeReceipt(r) {
  mkdirSync(join(receiptPath(), '..'), { recursive: true });
  writeFileSync(receiptPath(), JSON.stringify(r, null, 2) + '\n', 'utf8');
}

function clearReceipt() {
  try {
    rmSync(receiptPath(), { force: true });
    rmdirSync(join(receiptPath(), '..'), { recursive: true, force: true });
  } catch { /* 清理失败不影响主流程 */ }
}

// ─── 路子一：volta install 本地 tarball（快照式，显式选择才用）─────

function voltaInstall() {
  console.log('[link:local] volta 模式：pnpm pack → volta install tarball（快照式）');
  if (!yes) {
    console.log('  将执行: pnpm pack --pack-destination <tmp>  //  volta install <tarball>（--yes 确认执行）');
    return false;
  }
  // tarball 打到系统临时目录 + finally 清理：不往仓库里留 *.tgz 垃圾
  const tmpDest = tmpdir();
  const pack = run('pnpm', ['pack', '--pack-destination', tmpDest], { cwd: ROOT });
  // pnpm pack 最后一行输出 tarball 路径——可能是裸文件名也可能是绝对路径，都能出现
  const last = pack.out.split(/\r?\n/).filter((l) => l.endsWith('.tgz')).pop();
  if (!last) {
    console.error('pnpm pack 没产出 tarball：\n' + pack.out + pack.err);
    return false;
  }
  const abs = isAbsolute(last) ? last : join(tmpDest, last);
  try {
    // shell:false —— Node 对 shell:true 的 args 不加引号，路径含空格直接劈坏；
    // volta.exe / pnpm.cmd 都能被 spawnSync 直接调（cmd shim 会经 cmd.exe 但无参数重排问题）
    const inst = run('volta', ['install', `${pkg.name}@${abs}`]);
    if (inst.code !== 0) {
      console.error('volta install 失败:\n' + (inst.out || inst.err));
      return false;
    }
    console.log(inst.out || inst.err);
    console.log(`[link:local] 已装 ${abs}（快照）`);
    console.log('[link:local] 注意：改代码后要重跑本命令；要实时生效用默认的覆盖式 shim。');
    return true;
  } finally {
    if (existsSync(abs)) rmSync(abs, { force: true });
  }
}

// ─── 路子二（默认）：覆盖式 shim —— 原地替换命令的真实落点 ─────────

const SHIM_TAG = 'rsx-sc-local-shim';

// dev 工件目录：`~/.rsx-sc/dev/`。清单与兜底 shim 都放这里——应用数据根目录本就存在
// （paths.js 的 appHome），不再为 dev shim 在用户空间另声明一个顶层目录。
// 刻意不走 appHome()（不随 NX_RSX_SC_HOME 漂移）：清单记录的是**机器级** shim 状态，
// 归属这台机器的 `~/rsx-sc/`，不归属某个会话的数据目录。
function devDir() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return join(home, pkg.name, 'dev');
}

// 按 PATH 顺序找 rsx-sc 的真实落点：第一个含有任何 rsx-sc 变体的目录，
// 就是用户敲 `rsx-sc` 时实际命中的那个。返回该目录下所有可文本覆盖的启动器变体
// （无扩展名 / .cmd / .ps1 / .bat，分别覆盖 cmd、PowerShell、Git Bash 三种调用方）。
// 只碰文本启动器；只有 .exe 的目录没法文本转发，单独报告给上层走兜底。
function resolveTargets() {
  const dirs = (process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean);
  for (const d of dirs) {
    if (/%[^%]+%/.test(d) || /WindowsApps/i.test(d)) continue; // 变量无法保证解析 / 商店 reparse 点，不碰
    const textExts = IS_WIN ? ['', '.cmd', '.ps1', '.bat'] : [''];
    const files = textExts.map((e) => join(d, 'rsx-sc' + e)).filter(existsSync);
    if (files.length) return { type: 'text', dir: d, files };
    const exe = join(d, 'rsx-sc.exe');
    if (existsSync(exe)) return { type: 'exe', dir: d, file: exe };
  }
  return null;
}

/**
 * 真实 node.exe 的绝对路径 —— 直接写进转发器，绕开 PATH 上的 node。
 *
 * 实测（Windows 11 / Volta / Git Bash）：POSIX 转发器里 `exec node "$@"` 走的是
 * PATH 上的 node，而它可能是 Volta 之类的**转发 shim**；那一跳会把多行参数截断成
 * 首行（`$'l1\nl2\nl3'` 到达时只剩 `l1`），且**不报错**——一次性凭据就这么丢掉。
 * 换成本脚本进程自己的 execPath（shim 是先解析再 exec 的，这里拿到的就是真实
 * node.exe）后，多行参数原样送达。
 *
 * 注意这修不了 `.cmd` 那条路：cmd.exe 解析 .cmd 文件内容时就把参数毁了，
 * 与 node 是不是 shim 无关（实测两种写法结果完全一样）。cmd/PowerShell 的用户
 * 多行值必须走 --data / stdin，这一条写在 ref 20-secrets 里。
 */
function realNodePath() {
  return process.execPath.replace(/\\/g, '/');
}

function shimBodyFor(file) {
  const bin = join(ROOT, 'bin', 'rsx-sc.mjs').replace(/\\/g, '/');
  const nodeExe = realNodePath();
  // 回退是必须的：node 升级会换版本目录（…/image/node/24.18.0/node.exe），
  // 写死的路径就失效了。失效时退回 PATH 上的 node —— 至少保持可用（代价是多行
  // 又会被 Volta 那一跳截断），重跑 `pnpm run link:local` 即可恢复直连。
  const posix = `#!/bin/sh\n# ${SHIM_TAG} -> ${ROOT}\n`
    + `NODE="${nodeExe}"\n[ -x "$NODE" ] || NODE=node\n`
    + `exec "$NODE" "${bin}" "$@"\n`;
  if (file.endsWith('.ps1')) return `# ${SHIM_TAG} -> ${ROOT}\n& "${nodeExe}" "${bin}" @args\n`;
  // .cmd 保持走 PATH 上的 node：实测直连真实 node.exe 与走 shim 结果完全相同，
  // 因为瓶颈是 cmd.exe 对 .cmd 内容的解析（%* 展开），换 node 解决不了。
  if (file.endsWith('.cmd') || file.endsWith('.bat')) return `@REM ${SHIM_TAG} -> ${ROOT}\r\n@node "${bin}" %*\r\n`;
  return posix;
}

const isExtensionless = (f) => !basename(f).includes('.');

function shimInstall() {
  const prev = readReceipt();
  const found = resolveTargets();

  // --auto（build 链路）：没有现成落点就什么都不做——不新建目录、不动 PATH
  if (!found) {
    if (auto) {
      console.log('[link:local] --auto：PATH 上没有现成的 rsx-sc，跳过（不新建、不动 PATH）。');
      return true;
    }
    console.log('[link:local] PATH 上没有现成的 rsx-sc 可覆盖。');
    return shimInstallFallback();
  }
  if (found.type === 'exe') {
    if (auto) {
      console.log(`[link:local] --auto：${found.file} 是二进制启动器，无法文本覆盖，跳过。`);
      return true;
    }
    console.log(`[link:local] ${found.file} 是二进制启动器，无法文本覆盖。`);
    return shimInstallFallback();
  }

  const { dir, files } = found;
  // 逐个决定备份：已是本工具转发器的，原件以既有 v2 清单为准（重装不许把转发器当原件）——
  // 没有这条保护，重装会把转发器内容当「原件」存进清单，unlink 永远还原不回真正的原件。
  const prevV2 = (prev && prev.version === 2 && samePath(prev.targetDir || '', dir)) ? prev : null;
  const plan = files.map((f) => {
    let cur = null;
    try { cur = readFileSync(f, 'utf8'); } catch { /* 读不动按不存在处理 */ }
    if (cur !== null && cur.includes(SHIM_TAG)) {
      if (prevV2 && prevV2.originals[f] !== undefined) return { file: f, original: prevV2.originals[f] };
      console.warn(`[link:local] 注意: ${f} 已是转发器但无备份记录，unlink 将恢复为当前内容。`);
      return { file: f, original: cur };
    }
    return { file: f, original: cur }; // null = 原本不存在
  });

  console.log('[link:local] 覆盖模式：原地替换命令启动器（PATH 不动，已开终端立即生效）');
  console.log(`  目录: ${dir}`);
  for (const p of plan) {
    console.log(`  ${p.file}  ${p.original === null ? '(原本不存在，unlink 时删除)' : '(原件已备份，unlink 时写回)'}`);
  }

  if (!yes) return false;

  const receipt = {
    version: 2,
    mode: 'shim',
    targetDir: dir,
    originals: {},
    pathEdit: null,
    installedAt: new Date().toISOString(),
  };
  for (const p of plan) {
    writeFileSync(p.file, shimBodyFor(p.file), 'utf8');
    if (isExtensionless(p.file)) chmodSync(p.file, 0o755); // Git Bash 跑无扩展名脚本需要 x 位
    receipt.originals[p.file] = p.original;
  }
  writeReceipt(receipt);

  console.log(`[link:local] 验证: rsx-sc version   # 应显示 v${pkg.version}（无需重开终端）`);
  console.log('[link:local] 还原: pnpm run unlink:local');
  return true;
}

// 兜底落点（只在 PATH 上没有可覆盖的 rsx-sc 时使用）：**绝不写进包管理器自己的目录。**
// 那里的文件归包管理器管，更新时可能被清掉或冲突。优先级：
//   1. 用户 PATH 上排在现有条目前的既有干净目录（不改注册表）
//   2. 新建 ~/rsx-sc/dev + 插到用户 PATH 最前面（走防御性 addToUserPath）
function pickShimDir() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!IS_WIN) {
    const dir = join(home, '.local', 'bin');
    const onPath = (process.env.PATH || '').split(':').some((d) => samePath(d, dir));
    return { dir, onPath, source: 'posix 默认' };
  }

  // 用户 PATH（.NET 读法不经 shell，不会被 MSYS 改写参数；拿到的就是注册表原文）
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    "[Environment]::GetEnvironmentVariable('Path','User', 'DoNotExpandEnvironmentNames')"], { encoding: 'utf8' });
  const userDirs = (r.stdout || '').trim().split(';').filter(Boolean);

  const voltaBin = findVoltaBin();
  const voltaIdx = voltaBin ? userDirs.findIndex((d) => samePath(d, voltaBin)) : -1;
  const before = voltaIdx >= 0 ? userDirs.slice(0, voltaIdx) : userDirs;

  // 候选目录：无 %VAR%（写入后无法保证解析）、非系统受管、真实存在
  const bad = /WindowsApps|\\uv\\|\\npm$|\\WinGet\\|\\Volta|\\Windows|System32|Program Files/i;
  const okDir = (d) => !/%[^%]+%/.test(d) && !bad.test(d) && existsSync(d);
  const ranked = before.filter(okDir).sort((a, b) => {
    const ha = /[/\\]bin$/i.test(a) && a.split('\\').length <= 3 ? 0 : 1;
    const hb = /[/\\]bin$/i.test(b) && b.split('\\').length <= 3 ? 0 : 1;
    return ha - hb || a.split('\\').length - b.split('\\').length;
  });
  if (ranked.length) {
    return { dir: ranked[0], onPath: true, source: '写入用户 PATH 上、排在现有条目之前的目录', needPathEdit: false };
  }
  return { dir: devDir(), onPath: false, source: 'PATH 上没有合适位置，新建专用目录', needPathEdit: true };
}

function shimInstallFallback() {
  const { dir, onPath, source, needPathEdit } = pickShimDir();
  const cmdFile = join(dir, 'rsx-sc.cmd');
  const shFile = join(dir, 'rsx-sc');
  console.log(`[link:local] 兜底落点：${source}`);
  console.log(`  ${cmdFile}   (cmd / PowerShell)`);
  console.log(`  ${shFile}    (Git Bash)`);

  // POSIX 分支不写 .cmd 垃圾文件
  const cmdBody = IS_WIN ? shimBodyFor(cmdFile) : null;
  if (!yes) {
    if (needPathEdit) console.log('[link:local] 将顺带把该目录插到用户 PATH 最前面');
    return false;
  }
  mkdirSync(dir, { recursive: true });
  if (cmdBody) writeFileSync(cmdFile, cmdBody, 'utf8');
  writeFileSync(shFile, shimBodyFor(shFile), 'utf8');
  chmodSync(shFile, 0o755);

  let pathOk = true;
  if (needPathEdit && !onPath) {
    pathOk = IS_WIN ? addToUserPath(dir) : (console.log(`  请加进 shell 配置：export PATH="${dir}:$PATH"`), false);
  }

  // 写安装清单：unlink 的唯一依据（originals 全为 null = 这两个文件都是新建的）
  writeReceipt({
    version: 2,
    mode: 'shim',
    targetDir: dir,
    originals: Object.assign(cmdBody ? { [cmdFile]: null } : {}, { [shFile]: null }),
    pathEdit: needPathEdit && !onPath ? dir : null,
    installedAt: new Date().toISOString(),
  });

  console.log(`[link:local] 验证: rsx-sc version   # 应显示 v${pkg.version}`);
  console.log('[link:local] 还原: pnpm run unlink:local');
  return pathOk;
}

// 读用户 PATH（注册表原文，不展开变量）。查询失败时返回 error——
// 上层必须中止，绝不能把「读不到」当成「用户 PATH 为空」去写（那会清空它）。
function readUserPath() {
  const query = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8' });
  if (query.status !== 0 || query.error) {
    // 键值不存在（status 1 + stderr）与查询失败（reg 被拦等）在这里无法区分，
    // 交给调用方用 PowerShell 读法复核
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
      "[Environment]::GetEnvironmentVariable('Path','User', 'DoNotExpandEnvironmentNames')"], { encoding: 'utf8' });
    if (ps.status !== 0 || ps.error) return { error: true, exists: false, isExpand: false, value: '' };
    const v = (ps.stdout || '').trim();
    if (v === '') return { error: false, exists: false, isExpand: false, value: '' };
    return { error: false, exists: true, isExpand: /%[^%]*%/.test(v), value: v };
  }
  const m = (query.stdout || '').match(/REG_(EXPAND_)?SZ\s+(.*)$/m);
  if (!m) return { error: true, exists: false, isExpand: false, value: '' };
  return { error: false, exists: true, isExpand: !!m[1], value: m[2] };
}

// 经 PowerShell 写用户 PATH。值经单引号转义（PS 单引号串里唯一的特殊字符是 '，
// 翻倍即转义），类型由 .NET 按是否含 % 自动选 REG_SZ / REG_EXPAND_SZ。
function setUserPath(value) {
  const esc = value.replace(/'/g, "''");
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `[Environment]::SetEnvironmentVariable('Path', '${esc}', 'User')`], { encoding: 'utf8' });
  if (r.status !== 0 || r.error) {
    console.error('[link:local] 写用户 PATH 失败:\n' + (r.stderr || r.stdout || r.error));
    return false;
  }
  // 写后回读校验：写坏 PATH 是不可接受的失败方式，宁可中止也不留残局
  const check = readUserPath();
  if (check.error || check.value !== value) {
    console.error('[link:local] 中止：写入后回读不一致，请检查用户 PATH 是否被改动。');
    return false;
  }
  return true;
}

function addToUserPath(dir) {
  const cur = readUserPath();
  if (cur.error) {
    console.error('[link:local] 中止：读不到用户 PATH（reg 与 PowerShell 双路都失败）。');
    console.error(`  请手动把 ${dir} 加到用户 PATH 最前面（系统属性 → 环境变量）。`);
    return false;
  }
  if (cur.value.split(';').filter(Boolean).some((d) => samePath(d, dir))) {
    console.log('[link:local] 用户 PATH 已有该目录，无需重复添加。');
    return true;
  }

  const next = cur.value ? dir + ';' + cur.value : dir;
  if (!yes) {
    console.log(`[link:local] 将把 ${dir} 插到用户 PATH 最前面`
      + (cur.exists ? `（${cur.value.length} → ${next.length} 字符）` : '（用户 PATH 当前不存在，将新建）'));
    return false;
  }
  if (!setUserPath(next)) return false;
  console.log('[link:local] 已写入用户 PATH 最前面。重开终端生效。');
  return true;
}

function removeFromUserPath(dir) {
  const cur = readUserPath();
  if (cur.error || !cur.exists) return;
  const all = cur.value.split(';').filter(Boolean);
  const kept = all.filter((d) => !samePath(d, dir));
  if (kept.length === all.length) return; // 本来就没有
  const next = kept.join(';');
  if (!yes) {
    console.log(`[link:local] 将从用户 PATH 摘除 ${dir}（--yes 时执行）`);
    return;
  }
  if (setUserPath(next)) console.log(`[link:local] 已从用户 PATH 摘除（${cur.value.length} → ${next.length} 字符）。重开终端生效。`);
}

// ─── 还原 ──────────────────────────────────────────────────────────

function shimUnlink() {
  const receipt = readReceipt();
  if (!receipt) {
    console.log('[link:local] 没有安装清单（未用本脚本装过 shim，或清单已被删）。');
    // 兜底：从清单的默认目录位置找一次
    const guess = devDir();
    let removed = 0;
    for (const f of [join(guess, 'rsx-sc.cmd'), join(guess, 'rsx-sc')]) {
      if (existsSync(f) && readFileSync(f, 'utf8').includes(SHIM_TAG)) {
        rmSync(f); removed++;
        console.log(`[link:local] 兜底删除: ${f}`);
      }
    }
    if (!removed) console.log(`[link:local] ${guess} 下也没有本工具的 shim。`);
    else console.log('[link:local] 若当时改过用户 PATH，请手动检查是否残留该目录条目。');
    return removed > 0;
  }

  for (const [f, original] of Object.entries(receipt.originals)) {
    if (!existsSync(f)) continue;
    let cur = '';
    try { cur = readFileSync(f, 'utf8'); } catch { /* 读不动当不是我们的 */ }
    if (!cur.includes(SHIM_TAG)) {
      console.log(`[link:local] ${f} 已不是本工具的转发器（无标记），跳过。`);
      continue;
    }
    if (original === null || original === undefined) {
      rmSync(f);
      console.log(`[link:local] 已删除（原本不存在）: ${f}`);
    } else {
      writeFileSync(f, original, 'utf8');
      if (isExtensionless(f)) chmodSync(f, 0o755);
      console.log(`[link:local] 已还原原件: ${f}`);
    }
  }
  if (receipt.pathEdit) removeFromUserPath(receipt.pathEdit);
  clearReceipt();
  console.log('[link:local] 还原完成。rsx-sc 回到安装前的原件（PATH 从未动过）。');
  return true;
}

// ─── 入口 ──────────────────────────────────────────────────────────

const state = detect();

console.log(`仓库:      ${ROOT}  (v${pkg.version})`);
console.log(`当前 rsx-sc: ${state.paths.join('\n            ') || '(PATH 上找不到)'}`);
if (state.voltaVersion) console.log(`volta 装的是: v${state.voltaVersion}`);
console.log(`是否已指向本仓库: ${state.isLocal ? '是' : '否'}`);
console.log('');

const mode = modeArg || 'shim'; // 默认覆盖式：有备份可还原、实时生效；volta 快照留给显式要求的人

if (unlink) {
  const ok = shimUnlink();
  process.exit(ok ? 0 : 1);
}

if (!yes) console.log('[link:local] 预览模式（--dry-run）——不会改动任何文件。\n');

const ok = unlink ? shimUnlink() : (mode === 'volta' ? voltaInstall() : shimInstall());
if (!unlink && !yes) {
  console.log(`  选定的模式: ${mode}${modeArg ? '（显式指定）' : '（默认覆盖式）'}`);
  console.log(`  用法: pnpm run link:local                覆盖式 shim，实时生效（默认动手）`);
  console.log(`        pnpm run link:local -- --dry-run  只预览不动手`);
  console.log(`        pnpm run link:local -- --mode=volta  快照式（volta install tarball，加 --yes 生效）`);
  console.log(`        pnpm run unlink:local             按清单还原原件`);
}
process.exit(ok ? 0 : 1);
