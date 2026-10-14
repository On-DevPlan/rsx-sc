// 命令表：CLI 命令 ↔ HTTP 路由的对照。
export async function commandTable() {
  const { ALL_COMMANDS, commandEntry } = await import('../../runtime/cli.js');
  return ALL_COMMANDS.map(commandEntry);
}