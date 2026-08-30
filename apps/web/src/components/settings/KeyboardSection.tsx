import { SHORTCUTS, SHORTCUT_GROUPS } from "../../lib/shortcuts.ts";
import { Kbd } from "../ui/Kbd.tsx";
import section from "./Section.module.css";

/** Rendered from the same registry `useKeyboardMap` dispatches from. */
export function KeyboardSection() {
  return (
    <div className={section.section}>
      <div className={section.head}>
        <h3 className={section.title}>Keyboard</h3>
      </div>
      <table className={section.table}>
        <thead>
          <tr>
            <th scope="col">Shortcut</th>
            <th scope="col">Action</th>
            <th scope="col">Group</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUT_GROUPS.flatMap((group) =>
            SHORTCUTS.filter((s) => s.group === group).map((shortcut) => (
              <tr key={shortcut.id} data-shortcut={shortcut.id}>
                <td>
                  <Kbd>{shortcut.keys}</Kbd>
                </td>
                <td>{shortcut.label}</td>
                <td className={section.group}>{shortcut.group}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}
