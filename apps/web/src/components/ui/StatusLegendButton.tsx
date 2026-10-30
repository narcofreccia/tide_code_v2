import { StatusLegendTable } from "../shell/StatusLegend.tsx";
import { Icon } from "./Icon.tsx";
import { Popover } from "./Popover.tsx";
import styles from "./StatusLegendButton.module.css";

/** A quiet `?` icon button that opens the status-glyph legend in a popover. */
export function StatusLegendButton({ align = "start" }: { align?: "start" | "end" }) {
  return (
    <Popover
      label={<Icon name="question" />}
      ariaLabel="Status legend"
      title="What do the status symbols mean?"
      variant="quiet"
      align={align}
      triggerClassName={styles.trigger}
    >
      {() => <StatusLegendTable />}
    </Popover>
  );
}
