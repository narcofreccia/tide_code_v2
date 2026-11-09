import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { defaultLogPath } from "./logFile.ts";
import { tideHomeOf } from "./runtime.ts";

export const LAUNCHD_LABEL = "com.tide.server";
export const SYSTEMD_UNIT = "tide-server.service";
/** per-user scheduled task (no admin): runs `service.cmd` at logon */
export const WIN_TASK = "Tide\\Server";

export interface ServiceSpec {
  platform: "darwin" | "linux" | "win32";
  /** where the unit/plist/wrapper goes */
  file: string;
  /** full argv: the binary (and script), `serve`, `--log …`, the user's serve flags */
  argv: string[];
  env: Record<string, string>;
  logPath: string;
}

/** How to re-run this same program: the compiled binary alone, or node + flags + the entry script. */
export function selfCommand(execPath: string = process.execPath, script: string | undefined = process.argv[1], isBun: boolean = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"): string[] {
  if (script === undefined || !existsSync(script)) return [execPath]; // bun --compile: the script is virtual
  return isBun ? [execPath, resolve(script)] : [execPath, "--experimental-strip-types", "--no-warnings=ExperimentalWarning", resolve(script)];
}

const isWinPath = (p: string): boolean => /^[A-Za-z]:|^\\\\/.test(p);

/** The Windows task's wrapper script: scheduled tasks cannot set environment variables or redirect. */
export function windowsWrapperFile(tideHome: string): string {
  return isWinPath(tideHome) ? win32.join(tideHome, "service.cmd") : join(tideHome, "service.cmd");
}

/** Where `tide service install` puts the launchd plist / systemd unit / Windows wrapper (`tideHome` is for win32). */
export function serviceFile(platform: "darwin" | "linux" | "win32", home: string, tideHome: string = join(home, ".tide")): string {
  if (platform === "win32") return windowsWrapperFile(tideHome);
  return platform === "darwin" ? join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`) : join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
}

export function serviceSpec(input: {
  platform: NodeJS.Platform;
  home: string;
  tideHome: string;
  command: string[];
  serveArgs: string[];
  path: string;
  /** TIDE_HOME set explicitly in this shell: the service must use the same one */
  explicitTideHome: boolean;
}): ServiceSpec {
  if (input.platform !== "darwin" && input.platform !== "linux" && input.platform !== "win32") throw new Error(`tide service supports macOS (launchd), Linux (systemd) and Windows (Task Scheduler); this is ${input.platform}`);
  const logPath = input.platform === "win32" && isWinPath(input.tideHome) ? win32.join(input.tideHome, "logs", "server.log") : defaultLogPath(input.tideHome);
  const file = serviceFile(input.platform, input.home, input.tideHome);
  return {
    platform: input.platform,
    file,
    argv: [...input.command, "serve", "--log", logPath, ...input.serveArgs],
    // the harness CLIs live on the user's PATH (nvm, homebrew, ~/.local/bin): a login service has a bare one
    env: { PATH: input.path, ...(input.explicitTideHome || input.platform === "win32" ? { TIDE_HOME: input.tideHome } : {}) },
    logPath,
  };
}

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function launchdPlist(spec: ServiceSpec): string {
  const args = spec.argv.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const env = Object.entries(spec.env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <!-- the server writes its own rotated log (--log); console output would only duplicate it -->
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`;
}

const systemdQuote = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function systemdUnit(spec: ServiceSpec): string {
  const env = Object.entries(spec.env).map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`).join("\n");
  return `[Unit]
Description=Tide server (tide serve)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${spec.argv.map(systemdQuote).join(" ")}
${env}
Restart=on-failure
RestartSec=5
# the server writes its own rotated log (--log)
StandardOutput=null
StandardError=null

[Install]
WantedBy=default.target
`;
}

const cmdQuote = (s: string): string => `"${s.replace(/%/g, "%%").replace(/"/g, '""')}"`;

/** `service.cmd`: sets the environment, then runs the server (it writes its own rotated log via --log). */
export function windowsWrapper(spec: ServiceSpec): string {
  const env = Object.entries(spec.env).map(([k, v]) => `set ${cmdQuote(`${k}=${v}`)}`);
  return ["@echo off", ...env, spec.argv.map(cmdQuote).join(" "), ""].join("\r\n");
}

export type Exec = (file: string, args: string[]) => Promise<{ code: number; out: string }>;

export const realExec: Exec = (file, args) =>
  new Promise((done) => {
    execFile(file, args, { timeout: 20_000 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1;
      done({ code, out: `${stdout}${stderr}`.trim() });
    });
  });

export interface ServiceDeps {
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  command?: string[];
}

/** `tide service install|uninstall|status`; returns the text to print and the exit code. */
export async function runService(action: "install" | "uninstall" | "status", serveArgs: string[], deps: ServiceDeps = {}): Promise<{ text: string; code: number }> {
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? realExec;
  const spec = serviceSpec({
    platform: deps.platform ?? process.platform,
    home: deps.home ?? homedir(),
    tideHome: tideHomeOf(env),
    command: deps.command ?? selfCommand(),
    serveArgs,
    path: env["PATH"] ?? "/usr/bin:/bin",
    explicitTideHome: env["TIDE_HOME"] !== undefined,
  });
  const uid = deps.uid ?? userInfo().uid;
  const domain = `gui/${uid}`;
  const out: string[] = [];
  const run = async (file: string, args: string[]): Promise<{ code: number; out: string }> => {
    const r = await exec(file, args);
    out.push(`$ ${file} ${args.join(" ")}${r.out ? `\n${r.out}` : ""}`);
    return r;
  };

  if (action === "status" && spec.platform === "win32") {
    const installed = existsSync(spec.file);
    const r = await exec("schtasks", ["/Query", "/TN", WIN_TASK, "/FO", "LIST", "/V"]);
    const running = r.code === 0 && /^\s*Status:\s*Running\b/im.test(r.out);
    return {
      text: [`service file: ${spec.file} (${installed ? "installed" : "not installed"})`, `state: ${running ? "running" : "not running"}`, `log: ${spec.logPath}`].join("\n"),
      code: running ? 0 : 3,
    };
  }

  if (action === "status") {
    const installed = existsSync(spec.file);
    const r = spec.platform === "darwin" ? await exec("launchctl", ["print", `${domain}/${LAUNCHD_LABEL}`]) : await exec("systemctl", ["--user", "status", SYSTEMD_UNIT, "--no-pager"]);
    const running = spec.platform === "darwin" ? /state = running/.test(r.out) : /Active: active \(running\)/.test(r.out);
    const pid = /pid = (\d+)/.exec(r.out)?.[1] ?? /Main PID: (\d+)/.exec(r.out)?.[1];
    return {
      text: [`service file: ${spec.file} (${installed ? "installed" : "not installed"})`, `state: ${running ? `running${pid ? ` (pid ${pid})` : ""}` : "not running"}`, `log: ${spec.logPath}`].join("\n"),
      code: running ? 0 : 3,
    };
  }

  if (action === "uninstall") {
    if (spec.platform === "win32") {
      await run("schtasks", ["/End", "/TN", WIN_TASK]); // fails harmlessly when not running
      await run("schtasks", ["/Delete", "/TN", WIN_TASK, "/F"]);
    } else if (spec.platform === "darwin") await run("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
    else {
      await run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    }
    const existed = existsSync(spec.file);
    rmSync(spec.file, { force: true });
    if (spec.platform === "linux") await run("systemctl", ["--user", "daemon-reload"]);
    out.push(existed ? `removed ${spec.file}` : `${spec.file} was not installed`);
    return { text: out.join("\n"), code: 0 };
  }

  const content = spec.platform === "darwin" ? launchdPlist(spec) : spec.platform === "win32" ? windowsWrapper(spec) : systemdUnit(spec);
  mkdirSync(dirname(spec.file), { recursive: true });
  mkdirSync(dirname(spec.logPath), { recursive: true, mode: 0o700 });
  writeFileSync(spec.file, content, { mode: 0o644 });
  out.push(`wrote ${spec.file}:`, "", content);
  let code = 0;
  if (spec.platform === "win32") {
    code = (await run("schtasks", ["/Create", "/SC", "ONLOGON", "/TN", WIN_TASK, "/TR", `"${spec.file}"`, "/RL", "LIMITED", "/F"])).code;
    if (code === 0) code = (await run("schtasks", ["/Run", "/TN", WIN_TASK])).code;
  } else if (spec.platform === "darwin") {
    await exec("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]); // replace a previous install; fails harmlessly when absent
    code = (await run("launchctl", ["bootstrap", domain, spec.file])).code;
  } else {
    await run("systemctl", ["--user", "daemon-reload"]);
    code = (await run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT])).code;
    out.push("", "To keep it running while you are logged out: loginctl enable-linger $USER");
  }
  out.push("", code === 0 ? `tide serve is now a login service; log: ${spec.logPath}` : "the service manager refused it (see above)", "Run `tide pair` for a pairing code.");
  return { text: out.join("\n"), code };
}
