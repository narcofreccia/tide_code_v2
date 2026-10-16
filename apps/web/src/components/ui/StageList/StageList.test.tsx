import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StageList } from "./StageList.tsx";
import { StageCard, stageMarker, StageTitle } from "./StageCard.tsx";
import { StageNote } from "./StageNote.tsx";
import { PresetChips } from "./PresetChips.tsx";

afterEach(cleanup);

describe("StageList", () => {
  it("numbers cards, offers reorder/remove and ends with the ghost add card", () => {
    const onMove = vi.fn();
    const onRemove = vi.fn();
    const onAdd = vi.fn();
    render(
      <StageList label="Stages" add={{ label: "Add a stage", onClick: onAdd }}>
        {["plan", "build"].map((role, i) => (
          <StageCard
            key={role}
            marker={stageMarker(i)}
            label={`Stage ${i + 1}`}
            subject={role}
            title={<StageTitle>{role}</StageTitle>}
            onMove={onMove}
            canMoveUp={i > 0}
            canMoveDown={i < 1}
            onRemove={onRemove}
          />
        ))}
      </StageList>,
    );
    expect(screen.getByRole("listitem", { name: "Stage 2" }).textContent).toContain("02");
    expect((screen.getByLabelText("Move plan up") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Move build up"));
    expect(onMove).toHaveBeenCalledWith(-1);
    fireEvent.click(screen.getByLabelText("Remove plan"));
    expect(onRemove).toHaveBeenCalledTimes(1);
    const items = screen.getAllByRole("listitem");
    expect(items.at(-1)?.textContent).toContain("Add a stage");
    fireEvent.click(screen.getByRole("button", { name: "Add a stage" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("StageNote shows the default as placeholder and summarises a custom value", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <StageNote label="Persona" hint="h" ariaLabel="Persona text" placeholder="the default" value="" onChange={onChange} />,
    );
    expect(screen.getByText("Default")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Persona/ }));
    const area = screen.getByLabelText("Persona text") as HTMLTextAreaElement;
    expect(area.placeholder).toBe("the default");
    fireEvent.change(area, { target: { value: "mine" } });
    expect(onChange).toHaveBeenCalledWith("mine");
    rerender(<StageNote label="Persona" hint="h" ariaLabel="Persona text" placeholder="the default" value="mine" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Use default" }));
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("PresetChips report pressed state and toggle by key", () => {
    const onToggle = vi.fn();
    render(
      <PresetChips
        label="Presets"
        chips={[
          { key: "a", label: "Alpha", pressed: true },
          { key: "b", label: "Beta", pressed: false },
        ]}
        onToggle={onToggle}
      />,
    );
    expect(screen.getByRole("button", { name: "Alpha" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    expect(onToggle).toHaveBeenCalledWith("b");
  });
});
