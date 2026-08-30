import fs from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build",
  ".next", ".nuxt", "out", "target", "vendor", ".terraform", "coverage",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", ".turbo", ".cache",
  "site-packages", ".idea", ".vscode", ".svelte-kit", "bin", "obj",
]);

/** Files that are large, generated, or minified carry no learning value. */
const IGNORED_FILE_PATTERNS = [
  /\.min\.(js|css)$/,
  /\.lock$/,
  /-lock\.json$/,
  /\.map$/,
  /\.snap$/,
];

const MAX_FILE_BYTES = 1_500_000;

export interface WalkedFile {
  /** Repo-relative POSIX path — the form every SourceRef uses. */
  path: string;
  absPath: string;
  size: number;
}

export interface WalkOptions {
  maxFiles?: number;
  extraIgnoredDirs?: string[];
}

export function walkRepo(root: string, options: WalkOptions = {}): WalkedFile[] {
  const ignoredDirs = new Set([...IGNORED_DIRS, ...(options.extraIgnoredDirs ?? [])]);
  const maxFiles = options.maxFiles ?? 20_000;
  const out: WalkedFile[] = [];

  const visit = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip rather than abort the scan
    }
    // Sort for deterministic output ordering.
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const abs = path.join(dir, entry.name);

      if (entry.isSymbolicLink()) continue; // avoid cycles and escaping the repo
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        visit(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (IGNORED_FILE_PATTERNS.some((re) => re.test(entry.name))) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;

      out.push({
        path: toPosix(path.relative(root, abs)),
        absPath: abs,
        size: stat.size,
      });
    }
  };

  visit(root);
  return out;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export function readFileSafe(absPath: string): string | undefined {
  try {
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return undefined;
  }
}
