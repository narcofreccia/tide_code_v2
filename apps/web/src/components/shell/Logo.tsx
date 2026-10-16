import { useId } from "react";

/**
 * The Tide Code logo: the wave puzzle-piece mark (brand gradient) followed by the
 * word "code" in the app's own type stack. The text takes `currentColor`, so it
 * tints with its surroundings; `size` is the mark's height. `assets/tide-logo.svg`
 * is the mark alone, used for the favicon.
 */
const MARK_W = 194.5;
const MARK_H = 196.25;

export function Logo({ size = 18, className }: { size?: number; className?: string }) {
  const uid = useId().replace(/:/g, "");
  const gap = 22;
  const fontSize = MARK_H * 0.62;
  const textW = fontSize * 2.3;
  const width = MARK_W + gap + textW;
  return (
    <svg
      className={className}
      width={Math.round((size * width) / MARK_H)}
      height={size}
      viewBox={`-2 -2 ${width + 4} ${MARK_H}`}
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <defs><linearGradient id={`${uid}-g1`} x1="6.77" y1="149.29" x2="197.57" y2="52.07" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#50e3c2"/><stop offset=".19" stopColor="#4fddc4"/><stop offset=".44" stopColor="#4ecdca"/><stop offset=".71" stopColor="#4cb3d4"/><stop offset=".99" stopColor="#4a90e2"/></linearGradient>
<linearGradient id={`${uid}-g2`} x1="16.23" y1="204.94" x2="119.97" y2="152.09" gradientUnits="userSpaceOnUse" href={`#${uid}-g1`}/></defs>
      <path d="M1.13,137.12c27.53-11.09,66.03-4.05,97.35,11.26,4.83,2.23,9.21,4.44,13.61,6.78,24.59,14.36,55.98,21.76,73.03,18.2,7.29-1.07,4.67-9.53,5.17-15.82,0-2.68,0-5.61,0-8.23.06-4.75-.16-6.4-4.76-5.72-19.01,2.77-36.14-13.6-33.84-32.85,1.49-14.88,14.4-26.47,29.15-26.55,2.85-.27,6.13.94,8.67.24.57-.33.71-1.04.75-1.74.06-4.16,0-14.69.03-24.51-.12-7.24.28-14.99-.19-20.77-.31-.66-1.22-.47-1.92-.52-9.17-.07-53.03.14-62.15-.09-1.41,0-1.1-2.8-1.01-4.53.17-3.04-.01-6.22-.74-9.26-2.07-8.96-8.34-16.56-16.69-20.32-20.65-9.53-44.19,7.53-42.01,29.92.11,2.12.38,4.37-1.56,4.26-2.98.05-10.03,0-18.38.02-13.81-.02-30.83.01-43.04,0-1.63.09-2.18-.27-2.29.9-.03,7.25,0,86.39-.01,98.02-.02.63.01,1.4.78,1.31h.06Z" fill={`url(#${uid}-g1)`}/><path d="M103.28,176.25c-12.45-6.62-23.31-11.63-36.23-15.75-34.54-10.79-54.05-5.19-65.46,1.92-1.9,1.84-1.72,5.42-1.36,8.01.67,4.97,2.8,9.6,6.06,13.19,3.96,4.86,11.86,8.06,17.74,8.32,11.45.19,58.07,0,91.23.06,12.36,0,21.89.01,24.65,0,.53-.02.48-.13-.3-.41-11.54-3.55-24.29-8.85-36.15-15.24l-.18-.09Z" fill={`url(#${uid}-g2)`}/>
      <text
        x={MARK_W + gap}
        y={MARK_H * 0.5}
        dominantBaseline="central"
        fontFamily="inherit"
        fontWeight="700"
        fontSize={fontSize}
        fill="currentColor"
      >
        code
      </text>
    </svg>
  );
}
