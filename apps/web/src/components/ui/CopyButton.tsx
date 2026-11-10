import { useState } from "react";
import { copyWithToast } from "../../lib/clipboard.ts";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";

/**
 * Icon-only Copy: reachable by Tab, but a mouse press does not take focus (the composer
 * keeps its caret). The icon turns into a check once the copy really happened.
 */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string | undefined }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="quiet"
      className={className}
      aria-label={label}
      title={copied ? "Copied" : label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void copyWithToast(text).then(setCopied)}
    >
      <Icon name={copied ? "check" : "copy"} size={12} />
    </Button>
  );
}
