#!/usr/bin/env node
import { runMcpServer } from "@tide/tide-mcp";
import { CliError, parseCli, USAGE } from "./cli/args.ts";
import { ConfigError } from "./config.ts";
import { HOME_IN_USE_EXIT_CODE, HomeInUseError } from "./homeLock.ts";
import { VERSION } from "./version.ts";

async function main(): Promise<number | undefined> {
  const command = parseCli(process.argv.slice(2));
  switch (command.cmd) {
    // `--mcp` turns this same binary into the Tide MCP stdio server. The bun-compiled
    // sidecar has no `packages/` on disk, so provider sessions re-exec it this way.
    case "mcp":
      await runMcpServer();
      return undefined;
    case "version":
      console.log(VERSION);
      return 0;
    case "help":
      console.log(USAGE);
      return 0;
    case "serve": {
      const { runServe } = await import("./cli/serve.ts");
      await runServe(command.args, command.legacy);
      return undefined; // keeps running
    }
    case "pair": {
      const { runPair } = await import("./cli/pair.ts");
      console.log(await runPair({ qr: command.qr, ansi: process.stdout.isTTY, ...(command.port !== undefined ? { port: command.port } : {}), ...(command.host !== undefined ? { host: command.host } : {}) }));
      return 0;
    }
    case "doctor": {
      const { runDoctor } = await import("./cli/doctor.ts");
      const result = await runDoctor(command.port);
      console.log(result.text);
      return result.code;
    }
    case "triage": {
      const { runTriage, hostProbes } = await import("./cli/triage.ts");
      const result = await runTriage(
        { issue: command.issue, noAgent: command.noAgent },
        { probes: hostProbes(), version: VERSION, binary: process.execPath, ...(command.port !== undefined ? { port: command.port } : {}) },
      );
      console.log(result.text);
      return result.code;
    }
    case "service": {
      const { runService } = await import("./cli/service.ts");
      const result = await runService(command.action, command.serveArgs);
      console.log(result.text);
      return result.code;
    }
    case "update": {
      const { runUpdate, platformTriple } = await import("./cli/update.ts");
      const { realExec, selfCommand } = await import("./cli/service.ts");
      const { tideHomeOf } = await import("./cli/runtime.ts");
      const { askYesNo } = await import("./cli/prompt.ts");
      return runUpdate(
        { check: command.check, yes: command.yes },
        {
          fetch: (url) => fetch(url),
          version: VERSION,
          tideHome: tideHomeOf(),
          platformTriple: platformTriple(),
          execPath: process.execPath,
          exec: realExec,
          isCompiled: selfCommand().length === 1,
          log: (line) => console.log(line),
          confirm: askYesNo,
          ...(process.env["TIDE_UPDATE_BASE"] ? { baseUrl: process.env["TIDE_UPDATE_BASE"] } : {}),
        },
      );
    }
  }
}

main()
  .then((code) => {
    if (code !== undefined) process.exit(code);
  })
  .catch((err: unknown) => {
    if (err instanceof HomeInUseError) {
      console.error(`tide: ${err.message}`);
      process.exit(HOME_IN_USE_EXIT_CODE);
    }
    if (err instanceof CliError) console.error(`tide: ${err.message}\n\n${USAGE}`);
    else if (err instanceof ConfigError || (err instanceof Error && err.name === "PairError")) console.error(`tide: ${err.message}`);
    else console.error(err);
    process.exit(1);
  });
