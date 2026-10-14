// 命令表：CLI 命令 ↔ HTTP 路由的对照。
//
// 动态 import runtime/cli.js 的原因：registry 静态依赖各模块，模块再静态依赖
// cli.js 会形成循环。这个函数只在启动完成后被调用，届时 cli.js 早已求值完毕。
export async function commandTable() {
  const { ALL_COMMANDS, commandEntry } = await import('../../runtime/cli.js');
  return ALL_COMMANDS.map(commandEntry);
}
