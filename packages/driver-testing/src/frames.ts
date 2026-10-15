/**
 * Transcript format: one JSON object per line.
 *
 *   { "t": "start", provider, version, scenario, synthetic? }   exactly once, first
 *   { "t": "proc", name? }                                       begins the next process/connection
 *   { "t": "expect_out", match }                                 what the driver must send next
 *   { "t": "in", frame }                                         what the harness sends back
 *   { "t": "exit", code }                                        the harness process ends
 *
 * A transcript is a list of processes (one per spawn / `query()` call / HTTP base URL).
 * Frames before the first `proc` belong to process 0.
 */

export interface StartFrame {
  t: "start";
  provider: string;
  version: string;
  scenario: string;
  /** hand-authored from a driver's fakes/fixtures rather than recorded from a real harness */
  synthetic?: boolean;
  [extra: string]: unknown;
}
export interface ProcFrame {
  t: "proc";
  name?: string;
}
export interface ExpectOutFrame {
  t: "expect_out";
  /** JSON subset (strings of the form `/re/flags` are regexes, `"$any"` matches anything) or a string pattern */
  match: unknown;
}
export interface InFrame {
  t: "in";
  /** the harness's frame; any string equal to `"$id"` becomes the `id` of the last matched outbound frame */
  frame: unknown;
}
export interface ExitFrame {
  t: "exit";
  code: number | null;
}

export type ScriptFrame = ExpectOutFrame | InFrame | ExitFrame;
export type Frame = StartFrame | ProcFrame | ScriptFrame;

export interface ProcessScript {
  name: string;
  frames: ScriptFrame[];
}

export interface Transcript {
  start: StartFrame;
  processes: ProcessScript[];
}

export function parseTranscript(text: string, source = "transcript"): Transcript {
  let start: StartFrame | undefined;
  const processes: ProcessScript[] = [{ name: "main", frames: [] }];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (line === "" || line.startsWith("//")) continue;
    let frame: Frame;
    try {
      frame = JSON.parse(line) as Frame;
    } catch (error) {
      throw new Error(`${source}:${index + 1}: not JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    const where = `${source}:${index + 1}`;
    switch (frame.t) {
      case "start":
        if (start !== undefined) throw new Error(`${where}: a second start frame`);
        start = frame;
        break;
      case "proc":
        if (start === undefined) throw new Error(`${where}: proc before start`);
        if (processes.length === 1 && processes[0]!.frames.length === 0 && frame.name !== undefined) processes[0]!.name = frame.name;
        else processes.push({ name: frame.name ?? `proc-${processes.length}`, frames: [] });
        break;
      case "expect_out":
      case "in":
      case "exit":
        if (start === undefined) throw new Error(`${where}: ${frame.t} before start`);
        processes.at(-1)!.frames.push(frame);
        break;
      default:
        throw new Error(`${where}: unknown frame type ${JSON.stringify((frame as { t?: unknown }).t)}`);
    }
  }
  if (start === undefined) throw new Error(`${source}: no start frame`);
  return { start, processes };
}

export function serializeFrames(frames: readonly Frame[]): string {
  return frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n";
}
