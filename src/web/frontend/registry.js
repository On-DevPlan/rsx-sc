// 视图注册表：新增面板 = 在模块里写 view.jsx + 在这里登记一行。
// App 的 tab 导航、hash 路由、懒加载全部由这张表驱动，改面板不用动壳。
//
// 与后端 src/runtime/registry.js 的模块表一一对应；
// tests/unit/registry.test.mjs 会断言两侧对齐——漏登记（或登记了不存在的视图）都会直接测试失败。
import { lazy } from 'react';

export const VIEWS = [
  { id: 'home', title: '首页', component: lazy(() => import('../../modules/home/view.jsx')) },
  { id: 'settings', title: '设置', component: lazy(() => import('../../modules/settings/view.jsx')) },
  { id: 'capture', title: '截屏', component: lazy(() => import('../../modules/capture/view.jsx')) },
];
