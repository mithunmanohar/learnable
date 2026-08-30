import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KBBuilder } from "../kb/builder.js";
import type { Concept, ConceptCatalog, DetectionRule, KBNode, SourceRef } from "../kb/types.js";

const EXTRACTOR = "concepts.bind@0.1.0";

let cached: ConceptCatalog | undefined;

/**
 * Loads the shipped concept catalog. Kept outside the extractor package so it
 * can be edited without touching code — the catalog is content, and it is
 * expected to grow every time its owner meets a concept worth keeping.
 */
export function loadCatalog(explicitPath?: string): ConceptCatalog {
  if (!explicitPath && cached) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = explicitPath
    ? [explicitPath]
    : [
        path.resolve(here, "../../../../catalog/concepts.json"),
        path.resolve(here, "../../../catalog/concepts.json"),
        path.resolve(process.cwd(), "catalog/concepts.json"),
      ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as ConceptCatalog;
      if (!explicitPath) cached = parsed;
      return parsed;
    } catch {
      continue;
    }
  }
  return { catalogVersion: "0.0.0", concepts: [] };
}

/**
 * Attaches catalog concepts to the nodes that exemplify them.
 *
 * This is the step that makes the catalog more than a glossary. A concept with
 * no bindings is something you have read about; a concept bound to three
 * sightings with line numbers is something you have seen in your own system,
 * and the second is what actually transfers.
 */
export function bindConcepts(kb: KBBuilder, catalogPath?: string): void {
  const catalog = loadCatalog(catalogPath);
  if (catalog.concepts.length === 0) {
    kb.addDiagnostic({
      level: "warn", extractor: EXTRACTOR,
      message: "Concept catalog could not be loaded; the knowledge base has no learning layer.",
    });
    return;
  }

  const nodes = kb.allNodes();
  const stackNames = new Set(kb.allStackItems().map((s) => s.name.toLowerCase()));
  const dependencyNames = new Set(
    nodes.filter((n) => n.kind === "dependency").map((n) => n.name.toLowerCase()),
  );
  const edgeLabels = kb.allEdges()
    .map((e) => `${e.label ?? ""} ${e.provenance.note ?? ""}`)
    .join("\n");

  for (const concept of catalog.concepts) {
    const matches = matchConcept(concept, {
      nodes, stackNames, dependencyNames, edgeLabels,
    });
    if (matches.nodeIds.length === 0 && !matches.viaDependency) continue;

    kb.addBinding({
      conceptId: concept.id,
      // Cap the instance list: a concept is illustrated by a few clear
      // sightings, and fifty is not more instructive than five.
      nodeIds: matches.nodeIds.slice(0, 12),
      strength: Number(Math.min(1, matches.strength).toFixed(2)),
      note: matches.note,
      provenance: {
        method: "heuristic",
        extractor: EXTRACTOR,
        confidence: Math.min(1, matches.strength),
        evidence: matches.evidence.slice(0, 6),
        note:
          `Bound by ${matches.ruleCount} detection rule(s) from the concept catalog. ` +
          `The concept's explanation is authored, not derived from this codebase; ` +
          `the sightings are extracted.`,
      },
    });
  }

  // Concepts referenced by stack items and decisions but never bound would be
  // dead links in the viewer, so surface them explicitly.
  const bound = new Set(kb.allStackItems().flatMap((s) => s.conceptIds ?? []));
  const known = new Set(catalog.concepts.map((c) => c.id));
  const missing = [...bound].filter((id) => !known.has(id));
  if (missing.length > 0) {
    kb.addDiagnostic({
      level: "gap", extractor: EXTRACTOR,
      message: `Referenced but absent from the catalog: ${missing.join(", ")}.`,
    });
  }
}

interface MatchContext {
  nodes: KBNode[];
  stackNames: Set<string>;
  dependencyNames: Set<string>;
  edgeLabels: string;
}

interface MatchResult {
  nodeIds: string[];
  evidence: SourceRef[];
  strength: number;
  ruleCount: number;
  viaDependency: boolean;
  note?: string;
}

function matchConcept(concept: Concept, ctx: MatchContext): MatchResult {
  const nodeIds = new Set<string>();
  const evidence: SourceRef[] = [];
  const notes: string[] = [];
  let strength = 0;
  let ruleCount = 0;
  let viaDependency = false;

  for (const rule of concept.detect ?? []) {
    const re = safeRegex(rule.pattern);
    if (!re) continue;
    const weight = rule.strength ?? 0.5;
    let ruleMatched = false;

    switch (rule.kind) {
      case "dependency": {
        for (const name of ctx.dependencyNames) {
          if (!re.test(name)) continue;
          ruleMatched = true;
          viaDependency = true;
          const node = ctx.nodes.find((n) => n.kind === "dependency" && n.name.toLowerCase() === name);
          if (node) {
            nodeIds.add(node.id);
            if (node.provenance.evidence?.[0]) evidence.push(node.provenance.evidence[0]);
          }
        }
        for (const name of ctx.stackNames) {
          if (re.test(name)) { ruleMatched = true; viaDependency = true; }
        }
        break;
      }
      case "nodeKind": {
        const matching = ctx.nodes.filter((n) => re.test(n.kind));
        if (matching.length > 0) {
          ruleMatched = true;
          for (const n of matching.slice(0, 12)) {
            nodeIds.add(n.id);
            if (n.location) evidence.push(n.location);
          }
        }
        break;
      }
      case "path": {
        const matching = ctx.nodes.filter((n) => n.location && re.test(n.location.file));
        if (matching.length > 0) {
          ruleMatched = true;
          for (const n of matching.slice(0, 8)) {
            nodeIds.add(n.id);
            if (n.location) evidence.push(n.location);
          }
        }
        break;
      }
      case "symbolName": {
        const matching = ctx.nodes.filter(
          (n) => (n.kind === "symbol" || n.kind === "dataModel" || n.kind === "uiComponent") && re.test(n.name),
        );
        if (matching.length > 0) {
          ruleMatched = true;
          for (const n of matching.slice(0, 12)) {
            nodeIds.add(n.id);
            if (n.location) evidence.push(n.location);
          }
        }
        break;
      }
      case "callName":
      case "decorator": {
        // Call and decorator text is preserved in node excerpts, component hook
        // lists and edge labels, so search those rather than reparsing sources.
        const matching = ctx.nodes.filter((n) => {
          const hooks = (n.attrs?.hooks as string[] | undefined)?.join(" ") ?? "";
          const haystack = `${n.location?.excerpt ?? ""} ${hooks} ${n.summary ?? ""}`;
          return re.test(haystack);
        });
        if (matching.length > 0 || re.test(ctx.edgeLabels)) {
          ruleMatched = true;
          for (const n of matching.slice(0, 12)) {
            nodeIds.add(n.id);
            if (n.location) evidence.push(n.location);
          }
        }
        break;
      }
      case "attr": {
        const matching = ctx.nodes.filter((n) => {
          const keys = Object.keys(n.attrs ?? {}).join(" ");
          const values = Object.values(n.attrs ?? {})
            .filter((v) => typeof v === "string")
            .join(" ");
          return re.test(keys) || re.test(values);
        });
        if (matching.length > 0) {
          ruleMatched = true;
          for (const n of matching.slice(0, 12)) {
            nodeIds.add(n.id);
            if (n.location) evidence.push(n.location);
          }
        }
        break;
      }
      case "import": {
        const matching = ctx.nodes.filter((n) => re.test(n.location?.excerpt ?? ""));
        if (matching.length > 0) {
          ruleMatched = true;
          for (const n of matching.slice(0, 8)) nodeIds.add(n.id);
        }
        break;
      }
    }

    if (ruleMatched) {
      ruleCount++;
      strength += weight;
      if (rule.note) notes.push(rule.note);
    }
  }

  return {
    nodeIds: [...nodeIds],
    evidence,
    strength,
    ruleCount,
    viaDependency,
    note: notes.length > 0 ? notes.join(" ") : undefined,
  };
}

function safeRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return undefined;
  }
}
