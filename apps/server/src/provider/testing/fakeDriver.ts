import type {
  ApprovalDecision,
  DriverEnv,
  NormalizedEvent,
  OpenSessionOptions,
  ProviderDriver,
  ProviderInstance,
  ProviderKind,
  ProviderSession,
  ProviderStatus,
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
  | { kind: "throw"; message: string };

export const emit = (event: NormalizedEvent): FakeStep => ({ kind: "event", event });
export const awaitApproval = (requestId: string): FakeStep => ({ kind: "await-approval", requestId });
export const awaitUserInput = (requestId: string): FakeStep => ({ kind: "await-user-input", requestId });
export const awaitInterrupt = (): FakeStep => ({ kind: "await-interrupt" });
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
    this.nativeSessionId = options.resume;
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
    const steps = this.control.takeScript(this.options.threadId);
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
  statusResult: ProviderStatus;
  statusError: Error | undefined;
  createError: Error | undefined;
  terminalCommandFor: (nativeSessionId: string, cwd: string) => string | undefined;
  #global: FakeStep[][] = [];
  #perThread = new Map<string, FakeStep[][]>();
  #received = new Map<string, Deferred<unknown>>();

  constructor(kind: ProviderKind) {
    this.kind = kind;
    this.statusResult = DEFAULT_STATUS(kind);
    this.terminalCommandFor = (id, cwd) => `${kind} --resume ${id} # ${cwd}`;
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
      /* nothing to release */
    },
  };
  const driver: ProviderDriver<Record<string, unknown>> = {
    kind,
    defaultConfig: () => ({}),
    async create(_config: Record<string, unknown>, _env: DriverEnv) {
      if (control.createError) throw control.createError;
      return instance;
    },
  };
  return { driver, control };
}
