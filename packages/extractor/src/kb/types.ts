/**
 * TypeScript mirror of spec/kb.schema.json and spec/concept.schema.json.
 *
 * The JSON Schema is canonical: it is the portable contract that any viewer or
 * third-party extractor codes against. These types exist so this package (and
 * the viewer, which imports them) get compile-time checking. `npm test` validates
 * real emitted output against the schema, which is what keeps the two in step.
 */

export const KB_VERSION = "0.1.0";

export type ProvenanceMethod = "extracted" | "heuristic" | "inferred" | "authored";

export interface SourceRef {
  file: string;
  startLine: number;
  endLine?: number;
  excerpt?: string;
}

export interface Provenance {
  method: ProvenanceMethod;
  extractor: string;
  confidence?: number;
  evidence?: SourceRef[];
  note?: string;
}

export type Layer =
  | "ui" | "client" | "transport" | "api" | "domain" | "data"
  | "infra" | "external" | "config" | "test" | "build" | "unknown";

export type NodeKind =
  | "service" | "module" | "file" | "symbol" | "route" | "uiComponent"
  | "dataModel" | "datastore" | "externalService" | "infraResource"
  | "envVar" | "job" | "test" | "dependency";

export interface KBNode {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName?: string;
  serviceId?: string;
  layer: Layer;
  location?: SourceRef;
  summary?: string;
  tags?: string[];
  attrs?: Record<string, unknown>;
  provenance: Provenance;
}

export type EdgeKind =
  | "imports" | "calls" | "renders" | "handles" | "httpCall"
  | "readsFrom" | "writesTo" | "transformsTo" | "extends" | "validates"
  | "definedIn" | "dependsOn" | "deploys" | "configures" | "changesWith"
  | "authGuards" | "emits" | "consumes" | "tests";

export interface KBEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  weight?: number;
  label?: string;
  attrs?: Record<string, unknown>;
  provenance: Provenance;
}

export type DataShapeKind =
  | "form-state" | "wire" | "dto" | "domain" | "row" | "query"
  | "cache" | "event" | "unknown";

export interface DataShape {
  name: string;
  nodeId?: string;
  kind: DataShapeKind;
  note?: string;
}

export type StepRole =
  | "ui-event" | "client-call" | "transport" | "route" | "middleware"
  | "validation" | "handler" | "domain" | "query" | "store"
  | "serialize" | "response" | "render" | "side-effect";

export interface TraceStep {
  index: number;
  nodeId?: string;
  layer: Layer;
  role: StepRole;
  title: string;
  detail?: string;
  dataShape?: DataShape;
  location?: SourceRef;
  conceptIds?: string[];
  provenance: Provenance;
}

export interface Trace {
  id: string;
  title: string;
  kind: "request" | "job" | "startup" | "auth" | "realtime";
  entryNodeId?: string;
  steps: TraceStep[];
  conceptIds?: string[];
  provenance: Provenance;
}

export interface ConceptBinding {
  conceptId: string;
  nodeIds: string[];
  strength?: number;
  note?: string;
  provenance: Provenance;
}

export interface Decision {
  id: string;
  title: string;
  chosen: string;
  alternatives?: { option: string; whyNot?: string }[];
  tradeoffs?: string[];
  relatedNodeIds?: string[];
  conceptIds?: string[];
  provenance: Provenance;
}

export interface Diagnostic {
  level: "info" | "gap" | "warn" | "error";
  extractor: string;
  message: string;
  file?: string;
}

export type StackCategory =
  | "language" | "runtime" | "frontend-framework" | "backend-framework"
  | "ui-library" | "styling" | "state-management" | "routing" | "data-fetching"
  | "orm" | "database" | "cache" | "queue" | "auth" | "validation"
  | "build" | "test" | "lint" | "container" | "iac" | "ci" | "observability" | "other";

export interface StackItem {
  id: string;
  name: string;
  version?: string;
  category: StackCategory;
  role?: string;
  serviceIds?: string[];
  conceptIds?: string[];
  provenance: Provenance;
}

export interface RepoInfo {
  name: string;
  remote?: string;
  branch?: string;
  commit?: string;
  scannedFiles: number;
  languages?: Record<string, number>;
}

export interface KnowledgeBase {
  kbVersion: string;
  generatedAt: string;
  generator: { name: string; version: string };
  repo: RepoInfo;
  stack?: StackItem[];
  nodes: KBNode[];
  edges: KBEdge[];
  traces?: Trace[];
  conceptBindings?: ConceptBinding[];
  decisions?: Decision[];
  diagnostics?: Diagnostic[];
}

/* ---------- concept catalog ---------- */

export interface DetectionRule {
  kind: "dependency" | "import" | "symbolName" | "callName" | "decorator" | "attr" | "path" | "nodeKind";
  pattern: string;
  languages?: string[];
  strength?: number;
  note?: string;
}

export interface Probe {
  id: string;
  kind: "predict" | "recall" | "apply" | "diagnose";
  question: string;
  answer: string;
  difficulty?: "intro" | "working" | "deep";
}

export interface Concept {
  id: string;
  name: string;
  category:
    | "data-modelling" | "persistence" | "api-design" | "auth" | "security"
    | "concurrency" | "distributed-systems" | "performance" | "caching"
    | "frontend-architecture" | "state-management" | "testing"
    | "deployment" | "observability" | "architecture-pattern";
  oneLiner: string;
  firstPrinciples: {
    problem: string;
    naive: string;
    failure: string;
    resolution: string;
    cost: string;
  };
  prerequisites?: string[];
  seeAlso?: string[];
  probes?: Probe[];
  detect?: DetectionRule[];
}

export interface ConceptCatalog {
  catalogVersion: string;
  concepts: Concept[];
}
