/**
 * How pi tool names are shown in Tide.
 *
 *  - pi 0.99+ names built-ins `builtin:<name>` in source info and diagnostics
 *    (CHANGELOG 0.99.0); the bare name (`read`, `bash`, `edit`) is what Tide's renderers know.
 *  - MCP tools are `mcp__<server>__<tool>` (docs/mcp.md § Configuration rules); pi's own TUI
 *    titles them `server/tool` (CHANGELOG 0.99.0), and so does Tide.
 */
export function displayToolName(name: string): string {
  if (name.startsWith("builtin:")) return name.slice("builtin:".length);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]}/${mcp[2]}`;
  return name;
}
