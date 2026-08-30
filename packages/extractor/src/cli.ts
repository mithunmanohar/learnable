#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { scan } from "./scan.js";

const USAGE = `
learnable — build a knowledge base from a repository

Usage:
  learnable scan [repo-path] [options]

Options:
  -o, --out <file>     Output path (default: <repo>/.learnable/kb.json)
      --no-git         Skip git history analysis (co-change edges)
      --max-files <n>  Cap on files scanned (default 20000)
      --quiet          Suppress the summary
  -h, --help           Show this message
`.trim();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "-h" || command === "--help" || command === "help") {
    console.log(USAGE);
    process.exit(command ? 0 : 1);
  }

  if (command !== "scan") {
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    process.exit(1);
  }

  const positional: string[] = [];
  let out: string | undefined;
  let useGit = true;
  let maxFiles = 20_000;
  let quiet = false;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-o" || arg === "--out") out = argv[++i];
    else if (arg === "--no-git") useGit = false;
    else if (arg === "--quiet") quiet = true;
    else if (arg === "--max-files") maxFiles = Number(argv[++i]) || maxFiles;
    else if (arg && !arg.startsWith("-")) positional.push(arg);
  }

  const repoRoot = path.resolve(positional[0] ?? process.cwd());
  if (!fs.existsSync(repoRoot)) {
    console.error(`No such directory: ${repoRoot}`);
    process.exit(1);
  }

  const kb = await scan(repoRoot, { useGit, maxFiles });

  const outPath = out ? path.resolve(out) : path.join(repoRoot, ".learnable", "kb.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(kb, null, 2)}\n`, "utf8");

  if (!quiet) {
    const counts = new Map<string, number>();
    for (const n of kb.nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
    const byKind = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${v} ${k}`)
      .join(", ");

    console.log(`\nScanned ${kb.repo.name} (${kb.repo.scannedFiles} files)`);
    console.log(`  nodes    ${kb.nodes.length}  — ${byKind}`);
    console.log(`  edges    ${kb.edges.length}`);
    console.log(`  traces   ${kb.traces?.length ?? 0}`);
    console.log(`  concepts ${kb.conceptBindings?.length ?? 0} bindings`);
    console.log(`  stack    ${kb.stack?.length ?? 0} items`);
    const gaps = (kb.diagnostics ?? []).filter((d) => d.level === "gap" || d.level === "warn");
    if (gaps.length > 0) {
      console.log(`\n  ${gaps.length} coverage gap(s):`);
      for (const g of gaps.slice(0, 8)) console.log(`    - [${g.extractor}] ${g.message}`);
      if (gaps.length > 8) console.log(`    … and ${gaps.length - 8} more (see diagnostics in the KB)`);
    }
    console.log(`\nWrote ${path.relative(process.cwd(), outPath) || outPath}\n`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
