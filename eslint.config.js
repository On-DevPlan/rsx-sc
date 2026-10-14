// ESLint 扁平配置。
//
// 这里主要管的不是代码风格（那个交给约定与编辑器），而是**分层约束**：
// 把「谁可以依赖谁」写成机器可检查的规则。架构意图一旦只写在文档里，
// 就会随提交次数慢慢衰减；写成 lint 规则则会当场拦下。
import { defineConfig } from 'eslint/config';
import react from 'eslint-plugin-react';

// 单文件字符数闸门。
//
// 与 BASE_RULES 里的 max-lines 是同一件事的两把尺子：行数管「结构」，字符数管「密度」。
// 只看行数时，把每行拉长就能继续膨胀；只看字符数时，密集短行又会被误伤。
// 两者都按「有效代码」计（跳过空行与注释），阈值 15000 对当前最大文件
// （scripts/link-local.mjs，约 12.7k 有效字符）留出余量：再翻一倍就该拆了。
//
// 注意这条闸门**不跟着 max-lines 给 scripts/ 与 tools/ 开豁免**：
// 行数豁免的本意是「开发脚本结构随意」，不是「体积可以无上限」。详见文件末尾。
//
// ESLint 没有内置的「单文件字符数」规则，这里用一份内联插件补上，
// 免得为一个阈值去引第三方插件或额外文件。
const FILE_SIZE = {
  rules: {
    'max-file-chars': {
      meta: {
        type: 'suggestion',
        docs: { description: '单个文件的有效字符数上限，防止文件体积膨胀' },
        schema: [
          {
            type: 'object',
            properties: { max: { type: 'integer', minimum: 1 } },
            additionalProperties: false,
          },
        ],
      },
      create(context) {
        const max = (context.options[0] && context.options[0].max) || 15000;
        return {
          Program(node) {
            const source = context.sourceCode || context.getSourceCode();
            let text = source.getText();
            // 注释区间整段剔除：比正则可靠，不会误伤字符串里的 `//`
            for (const comment of [...source.getAllComments()].reverse()) {
              text = text.slice(0, comment.range[0]) + text.slice(comment.range[1]);
            }
            const count = text.replace(/\s/g, '').length;
            if (count > max) {
              // 消息用字符串拼接，**不要**用 ESLint 的 messages/messageId 插值：
              // 那套语法是「双花括号 + 变量名」，而本文件是模板文件，模板引擎
              // 同样把双花括号当生成变量，生成项目时直接报「未声明的变量」。
              // 连这段注释里都不能出现双花括号，否则生成期一样会红。
              context.report({
                node,
                message: `单文件有效字符数 ${count} 超过上限 ${max}，请按职责拆分文件。`,
              });
            }
          },
        };
      },
    },
  },
};

const BASE_RULES = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-undef': 'off', // 浏览器/Node 全局混用，靠运行时暴露；装 globals 包不值得
  eqeqeq: ['error', 'smart'],
  'prefer-const': 'error',
  'no-var': 'error',
  'no-console': 'off', // CLI 工具，输出就是产品
  // 文件行数上限：防止单文件持续膨胀，超限应先拆分
  'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
};

export default defineConfig([
  { ignores: ['src/web/public/**', 'node_modules/**', 'templates/**'] },
  {
    files: ['**/*.{js,mjs,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: BASE_RULES,
  },

  // JSX：基础 ESLint 的 no-unused-vars 不把 JSX 标签算作变量使用
  // （TS 模板由 typescript-eslint 处理）。jsx-uses-vars 是标记规则，
  // 让只在 JSX 中出现的组件/变量不被误报为未使用。
  {
    files: ['**/*.jsx'],
    plugins: { react },
    rules: { 'react/jsx-uses-vars': 'error' },
  },

  // 字符数闸门：覆盖所有被 lint 的文件，**不**给 scripts/ 与 tools/ 开豁免 ——
  // 下面那条 max-lines 豁免管的是「结构」，体积上限是产品约束，两者不是一回事。
  {
    files: ['**/*.{js,mjs,cjs,jsx}'],
    plugins: { local: FILE_SIZE },
    rules: { 'local/max-file-chars': ['error', { max: 15000 }] },
  },

  // ---- 分层约束（对应主文档「依赖只能向下 core ← modules ← runtime」）----

  {
    // core 是最底层：零业务语义的基础设施。它一旦依赖上层，分层就塌了。
    files: ['src/core/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../modules/**', '../runtime/**', '../web/**',
                '../../modules/**', '../../runtime/**', '../../web/**',
              ],
              message: 'core 是最底层，不得依赖 modules / runtime / web。',
            },
          ],
        },
      ],
    },
  },

  {
    // 模块之间禁止互相值依赖，需要共享的下沉到 core/。
    //
    // 逐模块枚举（与 nx-nx / TS 模板一致）：新增模块时把它的路径补进
    // files 与 group。枚举式规则的已知风险是「漏补静默」——靠
    // tests/unit 的注册表一致性断言兜底。
    files: ['src/modules/**/*.{js,jsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../home/*', '../home/**', '../skill/*', '../skill/**'],
              message: '模块之间不得互相依赖；共享逻辑请下沉到 core/。',
            },
          ],
        },
      ],
    },
  },

  {
    // 前端：这条规则的价值最高——把 Node 侧代码 import 进视图，
    // Vite 会把 node: 内置模块一起打进浏览器包，构建期报错或运行期炸掉。
    files: ['src/web/frontend/**/*.{js,jsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: '前端不能引用 Node 内置模块。',
            },
            {
              group: ['**/modules/*/index.js', '**/modules/*/service.js', '**/runtime/**', '**/core/**'],
              message:
                '前端只能 import 模块的 view.jsx。index.js/service.js/runtime/core 是 Node 侧代码，拖进浏览器包会把 node: 内置模块一起带进来。',
            },
          ],
        },
      ],
    },
  },

  // ---- 生成器专属区域：tools/ 要读模板树、写目标目录、spawn 进程 ----
  { files: ['tools/**/*.{js,mjs}'], rules: { 'no-restricted-imports': 'off' } },

  // 开发/生成器脚本与工具：不强制行数上限（src 内的产品代码才强制）。
  // 只豁免行数——上面的字符数闸门仍然生效，所以这里不要顺手把 max-file-chars 也关掉。
  {
    files: ['scripts/**/*.{js,mjs}', 'tools/**/*.{js,mjs}'],
    rules: { 'max-lines': 'off' },
  },
]);
