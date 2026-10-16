# Composition dialogs

New experts session, New thread (Thread | Team) and the Team editor share one shape: a pipeline being assembled.
They are built from `ui/Dialog` (`variant="sheet"`), `ui/DialogFrame` and `ui/StageList/`.

- **Header** is a sentence about the outcome ("Ask a panel of experts to agree on one plan"), with one quiet context line under it (the project, "Child of …").
- **One primary field** leads the body: topic, task or team name, 15px, generous padding, focused on open, with an example as placeholder.
- **Members are cards in a visible order.** A tabular numeral (`01`) or role glyph (`◆` for the lead) sits in a left gutter; sequential lists join the gutters with a hairline so the run order reads top to bottom.
  The role is the card title (inline-editable), the tagline its subtitle, and the harness monogram + Agent · Model sit right as one joined control.
- **Reorder and remove** (↑ ↓ ×) appear on hover or keyboard focus only. **Add** is a dashed ghost card at the end of the list, never a button above it.
- **Presets are chips** above the list. In Experts they toggle a persona in or out; in Team they pick the saved team.
- **Long text** (persona, stage instructions) opens inside its card as a labelled editor with a hint; the default is the placeholder, never pre-filled.
- **Labels** are sentence case, 12px, `--text-2`. Captions under a control explain the choice (permission hints, model default).
- **Outcome line** above the footer says what happens on submit. The **footer** holds Cancel (quiet) and one primary with verb + count ("Start with 3 experts"); when disabled, a caption says why.
- **Keyboard:** Esc cancels, ⌘↵ submits from anywhere in the dialog. **Motion:** one 120ms fade + rise on open, a short expand for the inline editor.
- **Density:** 13px base, 28px controls, 8/12/16 spacing, max width 640px; header and footer stay put while the body scrolls.
