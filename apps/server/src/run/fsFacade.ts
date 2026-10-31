import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * The read-only view of a repo the scanner works over. Paths are POSIX, relative to the repo root
 * ("" = the root). `list` returns entry names, directories suffixed with "/".
 */
export interface RepoFs {
  /** undefined when missing, not a file, or larger than `maxBytes` */
  readText(rel: string, maxBytes?: number): Promise<string | undefined>;
  exists(rel: string): Promise<boolean>;
  list(rel: string): Promise<string[]>;
  /** `mtimeMs:size`, used as a cache key; undefined when missing */
  stamp?(rel: string): Promise<string | undefined>;
}

export const joinRel = (dir: string, name: string): string => (dir === "" || dir === "." ? name : `${dir.replace(/\/$/, "")}/${name}`);

export function nodeRepoFs(root: string): RepoFs {
  const abs = (rel: string): string => (rel === "" ? root : join(root, ...rel.split("/")));
  return {
    async readText(rel, maxBytes) {
      try {
        const info = await stat(abs(rel));
        if (!info.isFile()) return undefined;
        if (maxBytes !== undefined && info.size > maxBytes) return undefined;
        return await readFile(abs(rel), "utf8");
      } catch {
        return undefined;
      }
    },
    async exists(rel) {
      try {
        await stat(abs(rel));
        return true;
      } catch {
        return false;
      }
    },
    async list(rel) {
      try {
        const entries = await readdir(abs(rel), { withFileTypes: true });
        return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
      } catch {
        return [];
      }
    },
    async stamp(rel) {
      try {
        const info = await stat(abs(rel));
        return `${info.mtimeMs}:${info.size}`;
      } catch {
        return undefined;
      }
    },
  };
}

/** In-memory RepoFs for tests: keys are relative file paths. */
export function memRepoFs(files: Record<string, string>): RepoFs {
  const paths = Object.keys(files);
  const isDir = (rel: string): boolean => rel === "" || paths.some((p) => p.startsWith(`${rel}/`));
  return {
    async readText(rel, maxBytes) {
      const text = files[rel];
      if (text === undefined) return undefined;
      if (maxBytes !== undefined && Buffer.byteLength(text) > maxBytes) return undefined;
      return text;
    },
    async exists(rel) {
      return files[rel] !== undefined || isDir(rel);
    },
    async list(rel) {
      const prefix = rel === "" ? "" : `${rel}/`;
      const out = new Set<string>();
      for (const p of paths) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf("/");
        out.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
      }
      return [...out].sort();
    },
  };
}
