import type {
  ConceptBinding, Decision, Diagnostic, KBEdge, KBNode, KnowledgeBase,
  Provenance, RepoInfo, SourceRef, StackItem, Trace,
} from "./types.js";
import { KB_VERSION } from "./types.js";

/**
 * Accumulates extractor output into a knowledge base.
 *
 * Two invariants it enforces, because both are easy to violate by accident and
 * expensive to discover later:
 *
 *  1. Node ids are deterministic and unique. Determinism is what makes two scans
 *     of the same repo diffable, which is what makes the change briefing work.
 *  2. Edges never dangle. An edge pointing at a node that was never emitted
 *     renders as a hole in the graph, so we drop it and record a diagnostic
 *     rather than emitting a KB that a viewer cannot lay out.
 */
/**
 * An outbound HTTP call found in client code, before it has been matched to a
 * route. Declared here rather than in the TypeScript extractor so the builder
 * can carry it to the trace synthesiser without a circular import.
 */
export interface HttpCallSite {
  method: string;
  url: string;
  callerSymbolId: string;
  callerName: string;
  file: string;
  ref: SourceRef;
}

export class KBBuilder {
  /** Cross-service call sites, populated by client-side extractors. */
  httpCallSites: HttpCallSite[] = [];

  private nodes = new Map<string, KBNode>();
  private edges = new Map<string, KBEdge>();
  private traces: Trace[] = [];
  private bindings: ConceptBinding[] = [];
  private decisions: Decision[] = [];
  private diagnostics: Diagnostic[] = [];
  private stack = new Map<string, StackItem>();

  addNode(node: KBNode): string {
    const existing = this.nodes.get(node.id);
    if (existing) {
      // Two extractors legitimately see the same thing (a route handler is also
      // a symbol). Keep the richer record instead of letting order decide.
      this.nodes.set(node.id, mergeNodes(existing, node));
      return node.id;
    }
    this.nodes.set(node.id, node);
    return node.id;
  }

  addEdge(edge: Omit<KBEdge, "id"> & { id?: string }): void {
    const id = edge.id ?? `${edge.kind}:${edge.from}->${edge.to}`;
    if (this.edges.has(id)) return;
    this.edges.set(id, { ...edge, id });
  }

  addTrace(trace: Trace): void { this.traces.push(trace); }
  addBinding(b: ConceptBinding): void { this.bindings.push(b); }
  addDecision(d: Decision): void { this.decisions.push(d); }
  addDiagnostic(d: Diagnostic): void { this.diagnostics.push(d); }

  addStackItem(item: StackItem): void {
    const existing = this.stack.get(item.id);
    if (existing) {
      // Prefer a record that knows its version and role.
      this.stack.set(item.id, {
        ...existing,
        ...item,
        serviceIds: unique([...(existing.serviceIds ?? []), ...(item.serviceIds ?? [])]),
      });
      return;
    }
    this.stack.set(item.id, item);
  }

  hasNode(id: string): boolean { return this.nodes.has(id); }
  getNode(id: string): KBNode | undefined { return this.nodes.get(id); }
  allNodes(): KBNode[] { return [...this.nodes.values()]; }
  allEdges(): KBEdge[] { return [...this.edges.values()]; }
  allStackItems(): StackItem[] { return [...this.stack.values()]; }
  nodesOfKind(kind: KBNode["kind"]): KBNode[] {
    return this.allNodes().filter((n) => n.kind === kind);
  }

  build(repo: RepoInfo, generator: { name: string; version: string }): KnowledgeBase {
    const kept: KBEdge[] = [];
    let dangling = 0;
    for (const edge of this.edges.values()) {
      if (this.nodes.has(edge.from) && this.nodes.has(edge.to)) kept.push(edge);
      else dangling++;
    }
    if (dangling > 0) {
      this.diagnostics.push({
        level: "gap",
        extractor: "kb.builder",
        message:
          `Dropped ${dangling} edge(s) whose endpoints were never resolved to a node. ` +
          `Usually an import of a third-party or generated module the extractors do not model.`,
      });
    }

    // Sort everything by id so the emitted file is byte-stable between runs on
    // an unchanged repo. Without this, `git diff` on the KB is pure noise and
    // the whole change-briefing idea falls apart.
    const nodes = [...this.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
    const edges = kept.sort((a, b) => a.id.localeCompare(b.id));

    return {
      kbVersion: KB_VERSION,
      generatedAt: new Date().toISOString(),
      generator,
      repo,
      stack: [...this.stack.values()].sort((a, b) => a.id.localeCompare(b.id)),
      nodes,
      edges,
      traces: this.traces.sort((a, b) => a.id.localeCompare(b.id)),
      conceptBindings: this.bindings.sort((a, b) => a.conceptId.localeCompare(b.conceptId)),
      decisions: this.decisions.sort((a, b) => a.id.localeCompare(b.id)),
      diagnostics: this.diagnostics,
    };
  }
}

function mergeNodes(a: KBNode, b: KBNode): KBNode {
  return {
    ...a,
    ...b,
    // A more specific kind wins over the generic `symbol` fallback.
    kind: b.kind === "symbol" && a.kind !== "symbol" ? a.kind : b.kind,
    summary: b.summary ?? a.summary,
    location: b.location ?? a.location,
    tags: unique([...(a.tags ?? []), ...(b.tags ?? [])]),
    attrs: { ...(a.attrs ?? {}), ...(b.attrs ?? {}) },
    provenance: preferHarderEvidence(a.provenance, b.provenance),
  };
}

/** Never let an inferred claim overwrite an extracted fact. */
function preferHarderEvidence(a: Provenance, b: Provenance): Provenance {
  const rank = { extracted: 3, authored: 2, heuristic: 1, inferred: 0 } as const;
  const winner = rank[a.method] >= rank[b.method] ? a : b;
  const other = winner === a ? b : a;
  return {
    ...winner,
    evidence: dedupeRefs([...(winner.evidence ?? []), ...(other.evidence ?? [])]),
  };
}

function dedupeRefs(refs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const r of refs) {
    const key = `${r.file}:${r.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function unique<T>(items: T[]): T[] { return [...new Set(items)]; }

/* ---------- id helpers: deterministic, human-readable, stable ---------- */

export const ids = {
  service: (root: string) => `service:${root || "."}`,
  file: (path: string) => `file:${path}`,
  module: (path: string) => `module:${path}`,
  symbol: (path: string, name: string) => `symbol:${path}#${name}`,
  route: (method: string, path: string) => `route:${method.toUpperCase()} ${path}`,
  component: (path: string, name: string) => `uiComponent:${path}#${name}`,
  dataModel: (path: string, name: string) => `dataModel:${path}#${name}`,
  datastore: (name: string) => `datastore:${name}`,
  infra: (provider: string, name: string) => `infraResource:${provider}:${name}`,
  envVar: (key: string) => `envVar:${key}`,
  dependency: (eco: string, name: string) => `dependency:${eco}:${name}`,
  external: (name: string) => `externalService:${name}`,
};
