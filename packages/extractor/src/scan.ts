import path from "node:path";
import { KBBuilder, ids } from "./kb/builder.js";
import type { KnowledgeBase } from "./kb/types.js";
import { coChangeEdges, gitInfo } from "./core/git.js";
import { displayLanguage, languageForFile } from "./core/parse.js";
import { walkRepo } from "./core/walk.js";
import { extractManifests } from "./extractors/manifests.js";
import { extractPython } from "./extractors/python.js";
import { extractTypeScript } from "./extractors/typescript.js";
import { extractInfra } from "./extractors/infra.js";
import { extractTerraform } from "./extractors/terraform.js";
import { extractGitHubActions } from "./extractors/githubActions.js";
import { synthesiseTraces } from "./synth/traces.js";
import { bindConcepts } from "./concepts/bind.js";
import { deriveDecisions } from "./synth/decisions.js";

export const GENERATOR = { name: "@learnable/extractor", version: "0.1.0" };

export interface ScanOptions {
  useGit?: boolean;
  maxFiles?: number;
}

export async function scan(root: string, options: ScanOptions = {}): Promise<KnowledgeBase> {
  const kb = new KBBuilder();
  const files = walkRepo(root, { maxFiles: options.maxFiles });

  const services = extractManifests(kb, root, files);
  if (services.length === 0) {
    kb.addDiagnostic({
      level: "gap", extractor: "scan",
      message: "No dependency manifest found, so no service boundaries could be established.",
    });
  }

  // A single logical datastore that persisted models attach to. Infra extraction
  // upgrades this with the real engine when a compose file or IaC declares one.
  kb.addNode({
    id: ids.datastore("primary-database"),
    kind: "datastore",
    name: "Primary database",
    layer: "data",
    provenance: {
      method: "heuristic", extractor: "scan@0.1.0", confidence: 0.6,
      note: "Placeholder for the relational store that persisted models map onto.",
    },
  });

  await extractPython(kb, root, files, services);
  await extractTypeScript(kb, root, files, services);
  extractInfra(kb, root, files);
  extractTerraform(kb, files);
  extractGitHubActions(kb, files);

  synthesiseTraces(kb);
  deriveDecisions(kb);
  bindConcepts(kb);

  if (options.useGit !== false) {
    applyCoChange(kb, root, files);
  }

  const languages: Record<string, number> = {};
  for (const f of files) {
    const lang = languageForFile(f.path);
    if (!lang) continue;
    const name = displayLanguage(lang);
    languages[name] = (languages[name] ?? 0) + 1;
  }

  const git = gitInfo(root);
  return kb.build(
    {
      name: path.basename(root),
      remote: git.remote,
      branch: git.branch,
      commit: git.commit,
      scannedFiles: files.length,
      languages,
    },
    GENERATOR,
  );
}

function applyCoChange(kb: KBBuilder, root: string, files: { path: string }[]): void {
  const known = new Set(files.map((f) => f.path));
  const pairs = coChangeEdges(root, { keepFile: (f) => known.has(f) });
  let added = 0;
  for (const pair of pairs) {
    const from = ids.file(pair.a);
    const to = ids.file(pair.b);
    if (!kb.hasNode(from) || !kb.hasNode(to)) continue;
    kb.addEdge({
      from, to, kind: "changesWith",
      weight: pair.ratio,
      label: `${Math.round(pair.ratio * 100)}% of commits`,
      attrs: { together: pair.together },
      provenance: {
        method: "extracted", extractor: "git.cochange@0.1.0",
        note:
          `Committed together ${pair.together} times. Co-change reveals coupling that the ` +
          `import graph does not show.`,
      },
    });
    added++;
  }
  if (added === 0) {
    kb.addDiagnostic({
      level: "info", extractor: "git.cochange@0.1.0",
      message: "No significant co-change pairs found (shallow clone or short history).",
    });
  }
}
