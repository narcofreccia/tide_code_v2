import wave from "../../assets/tide-wave.png";

/**
 * The Tide mark: two serif braces around the wave puzzle piece. The braces take
 * `currentColor` so the logo tints with the surrounding text (muted in the top
 * bar, full text colour on hover); the piece keeps its brand gradient, so it is
 * an embedded bitmap rather than a path. `assets/tide-logo.svg` is the same mark
 * as a standalone file, used for the favicon.
 */
export function Logo({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 1063 1063"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <text
        x="263.6"
        y="531.5"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="Times New Roman, Georgia, serif"
        fontSize="780"
        fill="currentColor"
      >
        {"{"}
      </text>
      <image href={wave} x="340.2" y="340.2" width="382.7" height="382.7" />
      <text
        x="799.4"
        y="531.5"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="Times New Roman, Georgia, serif"
        fontSize="780"
        fill="currentColor"
      >
        {"}"}
      </text>
    </svg>
  );
}
