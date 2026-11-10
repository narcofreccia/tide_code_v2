import { beforeEach } from "vitest";

// Components are tested against a server whose settings have answered (`settings.get`), as in
// the running app once connected. Tests of the loading / failed states set `loaded: false` themselves.
// Imported lazily so a test file's `vi.mock` of a state module applies before the store loads.
beforeEach(async () => {
  const { useServerSettings } = await import("./state/serverSettings.ts");
  useServerSettings.setState({ loaded: true, error: undefined });
});
