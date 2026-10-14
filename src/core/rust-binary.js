// Rust 二进制（`rsx-sc-rust`）平台解析与定位。
//
// 分发形态：**单包内嵌**——二进制随主包放在 `binaries/<platform>-<arch>/`，
// `files` 白名单把它打进 tarball。没有平台子包、没有 optionalDependencies，
// 一次 `npm publish` 即完整可用。
//
// fallback 链（顺序即优先级，参考 gh-action/A06）：
//   1. 环境变量 RSX_SC_BINARY —— 调试与自定义构建覆盖，必须最先
//   2. 显式额外目录（server-cli-web 的测试 / 自定义安装）
//   3. 随包的 binaries/<platform>-<arch>/ —— npm install 用户的主路径
//   4. rust/rsx-sc-rust/target/release/ —— 仓库内开发者的 cargo 产物
//   5. 都没有 → 返回 null，调用方给出「三条出路」的错误信息

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '..', '..');

/** 解析目标平台标识，例如 win32-x64 / linux-x64 */
export function resolveTarget(platform = process.platform, arch = process.arch) {
  const p = platform === 'win32' ? 'win32' : platform;
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  return { platform: p, arch: a, key: `${p}-${a}` };
}

/** 当前平台的二进制文件名 */
export function binaryName(platform) {
  return platform === 'win32' ? 'rsx-sc-rust.exe' : 'rsx-sc-rust';
}

/**
 * 是否支持当前平台。
 * v1：仅 Windows x64 与 Linux x64（macOS 留作 stub）。
 */
export function isSupported(platform, arch) {
  const t = resolveTarget(platform, arch);
  return t.key === 'win32-x64' || t.key === 'linux-x64';
}

/** 环境变量覆盖：调试 / 自定义构建时指向任意二进制。 */
export const BINARY_ENV = 'RSX_SC_BINARY';

function existsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 解析二进制路径。
 * @param {{platform?: string, arch?: string, extraDirs?: string[], env?: NodeJS.ProcessEnv}} [opts]
 * @returns {{path: string, source: string, platform: string, arch: string, key: string} | null}
 */
export function resolveBinary(opts = {}) {
  const target = resolveTarget(opts.platform, opts.arch);
  const file = binaryName(target.platform);
  const env = opts.env || process.env;

  // 1) 环境变量
  if (env[BINARY_ENV]) {
    const p = env[BINARY_ENV];
    if (existsFile(p)) return { path: p, source: 'env', ...target };
  }

  // 2) 显式额外目录
  for (const dir of opts.extraDirs || []) {
    const p = path.join(dir, file);
    if (existsFile(p)) return { path: p, source: 'extra', ...target };
  }

  // 3) 随包分发
  const bundled = path.join(PROJECT_ROOT, 'binaries', target.key, file);
  if (existsFile(bundled)) return { path: bundled, source: 'bundled', ...target };

  // 4) 仓库内开发者的 cargo 产物
  const cargo = path.join(PROJECT_ROOT, 'rust', 'rsx-sc-rust', 'target', 'release', file);
  if (existsFile(cargo)) return { path: cargo, source: 'cargo', ...target };

  return null;
}

/** 包自身版本 → 默认 Release tag */
export function packageVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')
    );
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 找不到二进制时的「三条出路」提示文案。 */
export function missingBinaryHint(target = resolveTarget()) {
  return [
    `未找到 ${target.key} 的 rsx-sc-rust 二进制。三条出路：`,
    '  1) 装包：npm i -g rsx-sc（或 npx rsx-sc），二进制随包分发',
    `  2) 自行编译：cd rust/rsx-sc-rust && cargo build --release，产物在 target/release/`,
    `  3) 显式指定：set ${BINARY_ENV}=<二进制绝对路径>`,
  ].join('\n');
}