import type {
  ApprovalDecision,
  DriverCaps,
  DriverEnv,
  NormalizedEvent,
  OpenSessionOptions,
  ProviderDriver,
  ProviderInstance,
  ProviderKind,
  ProviderSession,
  ProviderStatus,
  ReconfigureResult,
  SessionSettings,
  SlashCommandInfo,
  TurnInput,
} from "@tide/contracts";

// Scripted driver for tests: a turn is a list of steps, and the steps that wait
// (approval, user input, interrupt) make the driver's own suspension observable
// without a single sleep.

export type FakeStep =
  | { kind: "event"; event: NormalizedEvent }
  | { kind: "await-approval"; requestId: string }
  | { kind: "await-user-input"; requestId: string }
  | { kind: "await-interrupt" }
  /** suspends until the server steers a message into this turn */
  | { kind: "await-steer" }
  /** side effect run inside the turn, e.g. writing a file into the session's cwd */
  | { kind: "effect"; run: (options: OpenSessionOptions) => void | Promise<void> }
  | { kind: "throw"; message: string };

export const emit = (event: NormalizedEvent): FakeStep => ({ kind: "event", event });
export const awaitApproval = (requestId: string): FakeStep => ({ kind: "await-approval", requestId });
export const awaitUserInput = (requestId: string): FakeStep => ({ kind: "await-user-input", requestId });
export const effect = (run: (options: OpenSessionOptions) => void | Promise<void>): FakeStep => ({ kind: "effect", run });
export const awaitInterrupt = (): FakeStep => ({ kind: "await-interrupt" });
export const awaitSteer = (): FakeStep => ({ kind: "await-steer" });
export const throwStep = (message: string): FakeStep => ({ kind: "throw", message });

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const DEFAULT_STATUS = (kind: ProviderKind): ProviderStatus => ({
  kind,
  installed: true,
  loggedIn: true,
  version: "0.0.0-fake",
  models: [{ id: "fake-model", label: "Fake Model", default: true }],
  caps: { planMode: true, subagents: true, mcp: true, images: false, resume: true, contextUsage: true, openInTerminal: true },
});

export class FakeSession implements ProviderSession {
  readonly options: OpenSessionOptions;
  readonly control: FakeDriverControl;
  readonly inputs: TurnInput[] = [];
  nativeSessionId: string | undefined;
  closed = false;
  #waiters = new Map<string, Deferred<unknown>>();

  constructor(options: OpenSessionOptions, control: FakeDriverControl) {
    this.options = options;
    this.control = control;
    // a fork is a new native session that starts from another one's history
    this.nativeSessionId = options.resume ?? (options.forkFrom !== undefined ? `${options.forkFrom}~fork${control.sessions.length + 1}` : undefined);
  }

  #waiter<T>(key: string): Deferred<T> {
    let d = this.#waiters.get(key);
    if (!d) {
      d = deferred<unknown>();
      this.#waiters.set(key, d);
    }
    return d as Deferred<T>;
  }

  send(input: TurnInput): AsyncIterable<NormalizedEvent> {
    this.inputs.push(input);
    return this.#run(this.control.takeScript(this.options.threadId));
  }

  /** R14: what `hasBackgroundWork()` answers (backgrounded sub-agents still running). */
  backgroundWork = false;
  #harnessListeners: ((turn: { reason: string; events: AsyncIterable<NormalizedEvent> }) => void)[] = [];

  onHarnessTurn(listener: (turn: { reason: string; events: AsyncIterable<NormalizedEvent> }) => void): void {
    this.#harnessListeners.push(listener);
  }

  #idleListeners: ((event: NormalizedEvent) => void)[] = [];

  onIdleActivity(listener: (event: NormalizedEvent) => void): void {
    this.#idleListeners.push(listener);
  }

  /** R14: the harness produced activity between turns (a background sub-agent's tool call or progress). */
  emitIdleActivity(event: NormalizedEvent): void {
    for (const listener of this.#idleListeners) listener(event);
  }

  hasBackgroundWork(): boolean {
    return this.backgroundWork;
  }

  /**
   * R14: the harness starts a turn by itself. The items play like a scripted turn (plain events,
   * or steps such as `awaitInterrupt()`); `drained` resolves once the server consumed them all.
   */
  emitHarnessTurn(reason: string, items: ReadonlyArray<NormalizedEvent | FakeStep>): { drained: Promise<void> } {
    const steps = items.map((item): FakeStep => ("kind" in item ? item : emit(item)));
    const done = deferred<void>();
    const inner = this.#run(steps);
    async function* events(): AsyncGenerator<NormalizedEvent> {
      try {
        yield* inner;
      } finally {
        done.resolve(undefined);
      }
    }
    for (const listener of this.#harnessListeners) listener({ reason, events: events() });
    return { drained: done.promise };
  }

  #run(steps: FakeStep[]): AsyncGenerator<NormalizedEvent> {
    const self = this;
    async function* run(): AsyncGenerator<NormalizedEvent> {
      for (const step of steps) {
        switch (step.kind) {
          case "event":
            if (step.event.type === "session") self.nativeSessionId = step.event.nativeSessionId;
            yield step.event;
            break;
          case "await-approval":
            await self.#waiter<ApprovalDecision>(`approval:${step.requestId}`).promise;
            break;
          case "await-user-input":
            await self.#waiter<Record<string, unknown>>(`user-input:${step.requestId}`).promise;
            break;
          case "await-interrupt":
            await self.#waiter<void>("interrupt").promise;
            break;
          case "await-steer":
            await self.#waiter<TurnInput>("steer").promise;
            break;
          case "effect":
            await step.run(self.options);
            break;
          case "throw":
            throw new Error(step.message);
        }
      }
    }
    return run();
  }

  async respondApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    this.control.approvals.push({ requestId, decision });
    this.control.received(`approval:${requestId}`, decision);
    this.#waiter<ApprovalDecision>(`approval:${requestId}`).resolve(decision);
  }

  async respondUserInput(requestId: string, answers: Record<string, unknown>): Promise<void> {
    this.control.userInputs.push({ requestId, answers });
    this.control.received(`user-input:${requestId}`, answers);
    this.#waiter<Record<string, unknown>>(`user-input:${requestId}`).resolve(answers);
  }

  async interrupt(): Promise<void> {
    this.control.interrupts.push(this.options.threadId);
    this.control.received("interrupt", undefined);
    this.#waiter<void>("interrupt").resolve(undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.control.closed.push(this.options.threadId);
    this.control.received(`close:${this.options.threadId}`, undefined);
  }

  /** R4: only reached when `control.statusResult.caps.steer`; `control.steerError` makes the harness refuse. */
  async steer(input: TurnInput): Promise<void> {
    if (this.control.steerError) throw this.control.steerError;
    this.control.steers.push({ threadId: this.options.threadId, input });
    this.control.received(`steer:${this.options.threadId}`, input);
    this.#waiter<TurnInput>("steer").resolve(input);
  }

  /** R4: records how many turns the server asked the harness to forget. */
  async rollback(turns: number): Promise<void> {
    if (this.control.rollbackError) throw this.control.rollbackError;
    this.control.rollbacks.push({ threadId: this.options.threadId, turns, nativeSessionId: this.nativeSessionId });
    this.control.received(`rollback:${this.options.threadId}`, turns);
  }

  /** Answers with `control.reconfigureResult`; undefined = "this driver cannot switch live". */
  async reconfigure(settings: SessionSettings): Promise<ReconfigureResult> {
    this.control.reconfigures.push({ threadId: this.options.threadId, settings });
    return this.control.reconfigureResult ?? "reopen";
  }
}

/** Test-facing handle: script turns, observe driver calls, await them deterministically. */
export class FakeDriverControl {
  readonly kind: ProviderKind;
  readonly sessions: FakeSession[] = [];
  readonly opened: OpenSessionOptions[] = [];
  readonly approvals: { requestId: string; decision: ApprovalDecision }[] = [];
  readonly userInputs: { requestId: string; answers: Record<string, unknown> }[] = [];
  readonly interrupts: string[] = [];
  readonly closed: string[] = [];
  readonly reconfigures: { threadId: string; settings: SessionSettings }[] = [];
  readonly steers: { threadId: string; input: TurnInput }[] = [];
  readonly rollbacks: { threadId: string; turns: number; nativeSessionId: string | undefined }[] = [];
  steerError: Error | undefined;
  rollbackError: Error | undefined;
  reconfigureResult: ReconfigureResult | undefined;
  statusResult: ProviderStatus;
  statusError: Error | undefined;
  createError: Error | undefined;
  /** R8: every create() call: the merged config and the env (with `instance`) it was handed */
  readonly created: { config: Record<string, unknown>; env: DriverEnv; instance: ProviderInstance }[] = [];
  readonly disposed: ProviderInstance[] = [];
  /** R8: what listCommands answers; undefined = the instance has no listCommands */
  commandsResult: SlashCommandInfo[] | undefined;
  readonly listCommandsCalls: string[] = [];
  terminalCommandFor: (nativeSessionId: string, cwd: string) => string | undefined;
  #global: FakeStep[][] = [];
  #perThread = new Map<string, FakeStep[][]>();
  #received = new Map<string, Deferred<unknown>>();

  constructor(kind: ProviderKind) {
    this.kind = kind;
    this.statusResult = DEFAULT_STATUS(kind);
    this.terminalCommandFor = (id, cwd) => `${kind} --resume ${id} # ${cwd}`;
  }

  /** Turns R4 capabilities on/off. Call before anything reads the (cached) status. */
  setCaps(caps: Partial<DriverCaps>): void {
    this.statusResult = { ...this.statusResult, caps: { ...this.statusResult.caps, ...caps } };
  }

  /** Queues the script for the next turn (any thread). */
  script(...steps: FakeStep[]): void {
    this.#global.push(steps);
  }

  scriptFor(threadId: string, ...steps: FakeStep[]): void {
    const list = this.#perThread.get(threadId) ?? [];
    list.push(steps);
    this.#perThread.set(threadId, list);
  }

  takeScript(threadId: string): FakeStep[] {
    return this.#perThread.get(threadId)?.shift() ?? this.#global.shift() ?? [];
  }

  received(key: string, value: unknown): void {
    this.#waiter(key).resolve(value);
  }

  /** Resolves once the driver has been handed that approval/answer/interrupt. */
  when(key: string): Promise<unknown> {
    return this.#waiter(key).promise;
  }

  sessionFor(threadId: string): FakeSession | undefined {
    return [...this.sessions].reverse().find((s) => s.options.threadId === threadId);
  }

  #waiter(key: string): Deferred<unknown> {
    let d = this.#received.get(key);
    if (!d) {
      d = deferred<unknown>();
      this.#received.set(key, d);
    }
    return d;
  }
}

export interface FakeDriverHandle {
  driver: ProviderDriver<Record<string, unknown>>;
  control: FakeDriverControl;
}

export function createFakeDriver(kind: ProviderKind = "claude"): FakeDriverHandle {
  const control = new FakeDriverControl(kind);
  // one instance per create(): the registry keeps one per configured instance
  const makeInstance = (): ProviderInstance => {
    const instance: ProviderInstance = {
      kind,
      async status() {
        if (control.statusError) throw control.statusError;
        return control.statusResult;
      },
      async openSession(options: OpenSessionOptions) {
        control.opened.push(options);
        const session = new FakeSession(options, control);
        control.sessions.push(session);
        return session;
      },
      terminalCommand(nativeSessionId: string, cwd: string) {
        return control.terminalCommandFor(nativeSessionId, cwd);
      },
      async dispose() {
        control.disposed.push(instance);
      },
    };
    if (control.commandsResult !== undefined) {
      instance.listCommands = async ({ cwd }) => {
        control.listCommandsCalls.push(cwd);
        return control.commandsResult ?? [];
      };
    }
    return instance;
  };
  const driver: ProviderDriver<Record<string, unknown>> = {
    kind,
    defaultConfig: () => ({}),
    async create(config: Record<string, unknown>, env: DriverEnv) {
      if (control.createError) throw control.createError;
      const instance = makeInstance();
      control.created.push({ config, env, instance });
      return instance;
    },
  };
  return { driver, control };
}
