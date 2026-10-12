import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Fixture extension for the user-input recordings: a tool that asks the user through pi's own
 * dialog API (`ctx.ui.select` / `ctx.ui.input`), the way any third-party extension would.
 */
export default function askExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description: "Ask the user to pick a colour and type a name.",
    // a plain JSON schema: TypeBox schemas are JSON schemas, and this keeps the fixture dependency-free
    parameters: { type: "object", properties: {} } as never,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const colour = await ctx.ui.select("Pick a colour", ["red", "blue"]);
      const name = await ctx.ui.input("Your name", "e.g. Ada");
      return { content: [{ type: "text", text: `colour=${colour ?? "(cancelled)"} name=${name ?? "(cancelled)"}` }], details: {} };
    },
  });
}
