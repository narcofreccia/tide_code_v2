import { Button } from "../ui/Button.tsx";
import styles from "./Card.module.css";

/** R16: whose request a card is when the parent answers it in place for a child thread. */
export interface RequestOrigin {
  title: string;
  onOpen: () => void;
}

/** The quiet head line of a child's card: "Approval needed from <title> · Open". */
export function RequestFrom({ what, from }: { what: string; from: RequestOrigin }) {
  return (
    <div className={styles.from}>
      <span className={styles.fromText}>
        {what} from <span className={styles.fromTitle}>{from.title}</span>
      </span>
      <span aria-hidden="true">·</span>
      <Button variant="link" onClick={from.onOpen} aria-label={`Open ${from.title}`}>
        Open
      </Button>
    </div>
  );
}
