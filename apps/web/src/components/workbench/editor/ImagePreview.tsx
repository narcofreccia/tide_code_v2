import { useState } from "react";
import { formatBytes } from "../../../lib/images.ts";
import styles from "./ImagePreview.module.css";

/** Image file preview. Always an `<img>` (SVG included) so nothing is ever inlined or scripted. */
export function ImagePreview({ src, path, size }: { src: string; path: string; size?: number | undefined }) {
  const [dims, setDims] = useState<{ w: number; h: number } | undefined>();
  const name = path.slice(path.lastIndexOf("/") + 1);
  const parts = [name, ...(dims ? [`${dims.w}×${dims.h}`] : []), ...(size !== undefined ? [formatBytes(size)] : [])];
  return (
    <div className={styles.preview}>
      <div className={styles.stage}>
        <img
          className={styles.img}
          src={src}
          alt={name}
          onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        />
      </div>
      <p className={styles.caption}>{parts.join(" · ")}</p>
    </div>
  );
}
