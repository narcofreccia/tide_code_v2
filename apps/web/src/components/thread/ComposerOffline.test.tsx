import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { KnownEnvironment } from "@tide/contracts";
import { Composer } from "./Composer.tsx";
import { ThreadHeader } from "./ThreadHeader.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { attachFakeStore, makeApproval, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { getDraft, resetDrafts } from "../../state/drafts.ts";
import { useEnvironments } from "../../state/envStore.ts";
import { useModel } from "../../state/model.ts";

afterEach(() => {
  resetDrafts();
  cleanup();
  resetUi();
  useEnvironments.setState({ environments: [], statuses: {}, primaryId: undefined });
});

const env = (id: string, name: string): KnownEnvironment => ({
  id,
  name,
  routes: [{ kind: "lan", url: `ws://${id}:3777/ws`, priority: 1 }],
  addedAt: 1,
});

/** Two machines: this one (primary, up) and studio-mac (down), which owns thread t2. */
function twoMachines(studio: "connected" | "offline"): void {
  useEnvironments.setState({
    environments: [env("here", "laptop"), env("studio", "studio-mac")],
    primaryId: "here",
    statuses: { here: { connection: "connected" }, studio: { connection: studio } },
  });
  useModel.setState({ ownership: { projects: {}, threads: { t1: "here", t2: "studio" } } });
}

const sendButton = (): HTMLButtonElement => screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;

describe("Composer while the server is unreachable", () => {
  // the outbox does not survive a drop (calls reject while offline), so a send is held, not queued
  it("disables send, keeps the text in the draft and says why", () => {
    const fake = attachFakeStore(modelWith({}));
    act(() => useModel.setState({ status: "reconnecting" }));
    render(<Composer thread={makeThread("t1")} />);
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "hold this" } });
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().title).toBe("Not connected to the server");
    expect(screen.getByText(/Not connected to the server\. Sending resumes when it reconnects/)).toBeDefined();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fake.dispatch).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toBe("hold this");
    expect(getDraft("t1")?.text).toBe("hold this");

    act(() => useModel.setState({ status: "open" }));
    expect(sendButton().disabled).toBe(false);
    expect(screen.queryByText(/Sending resumes/)).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "turn.request", text: "hold this" }));
  });
});

describe("A thread owned by an offline machine", () => {
  it("header and composer say the machine is offline; send is disabled", () => {
    const fake = attachFakeStore(modelWith({}));
    twoMachines("offline");
    const thread = makeThread("t2");
    render(
      <>
        <ThreadHeader thread={thread} />
        <Composer thread={thread} />
      </>,
    );
    expect(screen.getAllByText(/studio-mac is offline/).length).toBe(2);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().title).toBe("studio-mac is offline");
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    expect(fake.dispatch).not.toHaveBeenCalled();
  });

  it("a thread on the primary is unaffected by another machine being down", () => {
    attachFakeStore(modelWith({}));
    twoMachines("offline");
    const thread = makeThread("t1");
    render(
      <>
        <ThreadHeader thread={thread} />
        <Composer thread={thread} />
      </>,
    );
    expect(screen.queryByText(/is offline/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    expect(sendButton().disabled).toBe(false);
  });

  it("its approval card cannot be answered, and says why", () => {
    const fake = attachFakeStore(modelWith({}));
    twoMachines("offline");
    render(
      <ul>
        <ApprovalCard activity={makeApproval("a1", { threadId: "t2" })} active />
      </ul>,
    );
    const allow = screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    expect(allow.title).toBe("studio-mac is offline");
    fireEvent.keyDown(window, { key: "y" });
    expect(fake.dispatch).not.toHaveBeenCalled();
    act(() => useEnvironments.setState((s) => ({ statuses: { ...s.statuses, studio: { connection: "connected" } } })));
    expect(allow.disabled).toBe(false);
  });
});
