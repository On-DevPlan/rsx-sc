import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 前端源码根下的文件会被暴露成 URL：src/web/frontend/api/client.js → /api/client.js。
// 而 /api 又是后端接口前缀，于是前端自己的模块请求会被代理吞掉——
// 浏览器拿到一坨 JSON、import 失败、整页白屏。
//
// 这是 Vite root 与服务端前缀的天然冲突：靠「目录别叫 api」这种约定防不住，
// 新增一个同名目录就会重现。所以按「是不是前端资源」决定走不走代理。
//
// ⚠️ 这段逻辑是骨架的一部分，别删也别改语义——它被单测钉着，
//    改坏的话 dev 模式会整页白屏，而且只在特定路径上出现，很难查。
const FRONTEND_ASSET = /\.(jsx?|mjs|cjs|tsx?|css|map|svg|png|jpe?g|webp|ico|woff2?)$/i;

export function shouldServeLocally(url) {
  const path = String(url || '').split('?')[0];
  return FRONTEND_ASSET.test(path) ? path : undefined; // 真值 = 交回 Vite
}

export default defineConfig({
  root: 'src/web/frontend',
  plugins: [react()],
  build: { outDir: '../public', emptyOutDir: true },
  server: {
    port: 7882,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7881',
        bypass: (req) => shouldServeLocally(req.url),
      },
    },
  },
});
