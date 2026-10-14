#!/usr/bin/env node
// logo 重生成 CLI：建项目后想换字母撞色，不必重新生成整个项目。
//
// 用法：
//   node tools/logo-gen/cli.mjs                 字母取包名（nx-<字母>），方案 mars
//   node tools/logo-gen/cli.mjs <letters>       指定字母
//   node tools/logo-gen/cli.mjs <letters> <scheme>
//
// 与生成器钩子（templates/.../hooks.mjs 的 afterGenerate）走同一个 generateAll，
// 两条路产出完全一致，不会出现「创建时一套、手动重生成另一套」的漂移。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAll, SCHEMES } from './index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// tools/logo-gen → 项目根
const root = here.replace(/[\\/]tools[\\/]logo-gen$/, '');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const letters = process.argv[2] || pkg.name.replace(/^nx-/, '');
const scheme = process.argv[3] || 'mars';

if (!/^[a-z]{1,5}$/.test(letters)) {
  console.error(`字母非法: "${letters}"，应为 1~5 位小写字母。`);
  process.exit(1);
}
if (!SCHEMES[scheme]) {
  console.error(`撞色方案不存在: "${scheme}"，可选: ${Object.keys(SCHEMES).join(' / ')}`);
  process.exit(1);
}

const outDir = join(root, 'src', 'web', 'frontend', 'public');
const result = await generateAll(outDir, letters, scheme);
console.log(`logo 已重生成 → ${outDir}`);
console.log(`  ${result.note}，共 ${result.files.length} 个文件`);
