import { ids, KBBuilder, type HttpCallSite } from "../kb/builder.js";
import type { KBNode, Trace, TraceStep } from "../kb/types.js";

const EXTRACTOR = "synth.traces@0.1.0";

/**
 * Builds end-to-end execution narratives by joining the two halves of the stack.
 *
 * Every other extractor works inside one service. This is the only place the
 * knowledge base crosses a process boundary, and it does so on the one thing
 * both sides genuinely agree on: the HTTP method and path. Everything else
 * (which component triggered it, which table it ended up reading) is reached by
 * walking edges outward from that join.
 */
export function synthesiseTraces(kb: KBBuilder): void {
  const routes = kb.nodesOfKind("route");
  if (routes.length === 0) {
    kb.addDiagnostic({
      level: "gap", extractor: EXTRACTOR,
      message: "No HTTP routes were found, so no request traces could be built.",
    });
    return;
  }

  const callSites = kb.httpCallSites;
  const matcher = new RouteMatcher(routes);

  let matched = 0;
  const unmatched: HttpCallSite[] = [];

  for (const site of callSites) {
    const route = matcher.match(site.method, site.url);
    if (!route) {
      unmatched.push(site);
      continue;
    }
    matched++;

    kb.addEdge({
      from: site.callerSymbolId, to: route.id, kind: "httpCall",
      label: `${site.method} ${site.url}`,
      provenance: {
        method: "extracted", extractor: EXTRACTOR, evidence: [site.ref, ...(route.location ? [route.location] : [])],
        note: "Client call site matched to a server route on method and path.",
      },
    });

    const trace = buildTrace(kb, site, route);
    if (trace) kb.addTrace(trace);
  }

  if (unmatched.length > 0) {
    const sample = unmatched.slice(0, 5).map((s) => `${s.method} ${s.url}`).join(", ");
    kb.addDiagnostic({
      level: "gap", extractor: EXTRACTOR,
      message:
        `${unmatched.length} client HTTP call(s) did not match any route in this repository ` +
        `(e.g. ${sample}). These usually target a third-party API or a service outside the scan.`,
    });
    for (const site of unmatched) {
      const host = /^https?:\/\/([^/]+)/.exec(site.url)?.[1];
      if (!host) continue;
      const extId = ids.external(host);
      kb.addNode({
        id: extId, kind: "externalService", name: host, layer: "external",
        summary: `Third-party HTTP dependency called from client code.`,
        attrs: { host },
        provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [site.ref] },
      });
      kb.addEdge({
        from: site.callerSymbolId, to: extId, kind: "httpCall",
        label: `${site.method} ${site.url}`,
        provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [site.ref] },
      });
    }
  }

  if (matched === 0 && callSites.length > 0) {
    kb.addDiagnostic({
      level: "gap", extractor: EXTRACTOR,
      message:
        "Client call sites and server routes were both found but none matched. " +
        "The client probably prefixes its base URL at runtime, which static matching cannot see.",
    });
  }
}

/* ---------- route matching ---------- */

interface CompiledRoute {
  node: KBNode;
  method: string;
  segments: string[];
}

class RouteMatcher {
  private compiled: CompiledRoute[];

  constructor(routes: KBNode[]) {
    this.compiled = routes.map((node) => ({
      node,
      method: String(node.attrs?.method ?? "GET").toUpperCase(),
      segments: splitPath(String(node.attrs?.path ?? "")),
    }));
  }

  /**
   * Matches on method plus path shape. Parameter segments (`{id}` server-side,
   * `${...}` or `:id` client-side) match any single concrete segment, which is
   * what makes a call to `/items/abc-123` line up with `GET /items/{id}`.
   */
  match(method: string, url: string): KBNode | undefined {
    const wanted = method.toUpperCase();
    const callSegments = splitPath(stripOrigin(url));

    let best: { route: CompiledRoute; score: number } | undefined;
    for (const route of this.compiled) {
      if (route.method !== wanted) continue;
      const score = scoreMatch(route.segments, callSegments);
      if (score === undefined) continue;
      if (!best || score > best.score) best = { route, score };
    }
    return best?.route.node;
  }
}

function stripOrigin(url: string): string {
  const withoutOrigin = url.replace(/^https?:\/\/[^/]+/, "");
  return withoutOrigin.split("?")[0] ?? withoutOrigin;
}

function splitPath(p: string): string[] {
  return p.split("/").filter((s) => s.length > 0);
}

function isParamSegment(s: string): boolean {
  return /^\{.*\}$/.test(s) || /^:.+/.test(s) || /^\$\{.*\}$/.test(s) || /^<.*>$/.test(s);
}

/** Higher is better; undefined means no match. Literal agreement beats wildcards. */
function scoreMatch(routeSegs: string[], callSegs: string[]): number | undefined {
  if (routeSegs.length !== callSegs.length) return undefined;
  let score = 0;
  for (let i = 0; i < routeSegs.length; i++) {
    const r = routeSegs[i] ?? "";
    const c = callSegs[i] ?? "";
    if (r === c) { score += 2; continue; }
    if (isParamSegment(r) || isParamSegment(c)) { score += 1; continue; }
    return undefined;
  }
  return score;
}

/* ---------- trace construction ---------- */

function buildTrace(kb: KBBuilder, site: HttpCallSite, route: KBNode): Trace | undefined {
  const steps: TraceStep[] = [];
  const push = (step: Omit<TraceStep, "index">): void => {
    steps.push({ ...step, index: steps.length });
  };

  const method = String(route.attrs?.method ?? site.method);
  const routePath = String(route.attrs?.path ?? site.url);

  // 1. The UI component that triggers the call, found by walking `calls` edges
  //    backwards from the SDK method to something that renders.
  const trigger = findTriggeringComponent(kb, site.callerSymbolId);
  if (trigger) {
    push({
      nodeId: trigger.id,
      layer: "ui",
      role: "ui-event",
      title: `\`${trigger.name}\` needs this data`,
      detail: describeHooks(trigger),
      location: trigger.location,
      dataShape: { name: "component state", kind: "form-state" },
      provenance: {
        method: "heuristic", extractor: EXTRACTOR, confidence: 0.75,
        evidence: trigger.location ? [trigger.location] : [],
        note: "Nearest component reached by following call edges back from the request.",
      },
    });
  }

  // 2. The client function that issues the request.
  const caller = kb.getNode(site.callerSymbolId);
  push({
    nodeId: site.callerSymbolId,
    layer: "client",
    role: "client-call",
    title: `\`${site.callerName}\` issues ${method} ${site.url}`,
    detail: caller?.summary,
    location: site.ref,
    dataShape: { name: "request options", kind: "dto" },
    provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [site.ref] },
  });

  // 3. The wire.
  push({
    layer: "transport",
    role: "transport",
    title: `${method} ${routePath} crosses the network`,
    detail: route.tags?.includes("authenticated")
      ? "Carries an Authorization header; the server will reject the request without a valid token."
      : undefined,
    dataShape: { name: "HTTP request", kind: "wire" },
    provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [site.ref] },
  });

  // 4. The route, and the auth gate in front of it.
  const auth = route.attrs?.auth as string | undefined;
  if (auth) {
    push({
      nodeId: route.id,
      layer: "api",
      role: "middleware",
      title: auth === "superuser"
        ? "Superuser check runs before the handler"
        : "Caller is resolved from the bearer token",
      detail: "A dependency resolves the current user and aborts the request if the token is missing, expired or insufficient.",
      location: route.location,
      conceptIds: ["concept.stateless-auth"],
      provenance: {
        method: "heuristic", extractor: EXTRACTOR, confidence: 0.85,
        evidence: route.location ? [route.location] : [],
      },
    });
  }

  push({
    nodeId: route.id,
    layer: "api",
    role: "route",
    title: `Router dispatches to the handler`,
    detail: `Declared as \`${method} ${routePath}\`.`,
    location: route.location,
    provenance: route.provenance,
  });

  const requestModel = route.attrs?.requestModel as string | undefined;
  if (requestModel) {
    const modelNode = findModelByName(kb, requestModel);
    push({
      nodeId: modelNode?.id,
      layer: "api",
      role: "validation",
      title: `Body is parsed into \`${requestModel}\``,
      detail: "Invalid input is rejected here, before any application code runs.",
      location: modelNode?.location ?? route.location,
      dataShape: { name: requestModel, nodeId: modelNode?.id, kind: "dto" },
      conceptIds: ["concept.boundary-validation"],
      provenance: {
        method: "extracted", extractor: EXTRACTOR,
        evidence: route.location ? [route.location] : [],
      },
    });
  }

  // 5. The handler, and whatever it touches in the database.
  const handlerId = route.attrs?.handlerId as string | undefined;
  const handler = handlerId ? kb.getNode(handlerId) : undefined;
  if (handler) {
    push({
      nodeId: handler.id,
      layer: "domain",
      role: "handler",
      title: `\`${handler.name}\` runs`,
      detail: handler.summary,
      location: handler.location,
      provenance: handler.provenance,
    });

    for (const access of dataAccessOf(kb, handler.id)) {
      const model = kb.getNode(access.to);
      if (!model) continue;
      const table = model.attrs?.table as string | undefined;
      push({
        nodeId: model.id,
        layer: "data",
        role: access.kind === "writesTo" ? "store" : "query",
        title: access.kind === "writesTo"
          ? `Writes \`${model.name}\`${table ? ` to table \`${table}\`` : ""}`
          : `Reads \`${model.name}\`${table ? ` from table \`${table}\`` : ""}`,
        detail: access.note,
        location: model.location,
        dataShape: {
          name: model.name,
          nodeId: model.id,
          kind: model.attrs?.persisted ? "row" : "domain",
        },
        conceptIds: ["concept.orm-mapping"],
        provenance: access.provenance,
      });
    }
  }

  // 6. Serialisation back out, which is where the shape changes again.
  const responseModel = route.attrs?.responseModel as string | undefined;
  if (responseModel) {
    const modelNode = findModelByName(kb, responseModel);
    push({
      nodeId: modelNode?.id,
      layer: "api",
      role: "serialize",
      title: `Result is reshaped into \`${responseModel}\``,
      detail: "The response model decides what leaves the server. Fields absent from it are not serialised, which is how internal columns stay internal.",
      location: modelNode?.location ?? route.location,
      dataShape: { name: responseModel, nodeId: modelNode?.id, kind: "dto" },
      conceptIds: ["concept.dto-projection"],
      provenance: {
        method: "extracted", extractor: EXTRACTOR,
        evidence: route.location ? [route.location] : [],
      },
    });
  }

  push({
    layer: "transport",
    role: "response",
    title: "Response travels back to the browser",
    dataShape: { name: "JSON payload", kind: "wire" },
    provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [site.ref] },
  });

  if (trigger) {
    push({
      nodeId: trigger.id,
      layer: "ui",
      role: "render",
      title: `\`${trigger.name}\` re-renders with the data`,
      detail: describeCacheBehaviour(trigger),
      location: trigger.location,
      dataShape: { name: "component state", kind: "form-state" },
      conceptIds: ["concept.server-state-cache"],
      provenance: {
        method: "heuristic", extractor: EXTRACTOR, confidence: 0.7,
        evidence: trigger.location ? [trigger.location] : [],
      },
    });
  }

  if (steps.length < 3) return undefined;

  const conceptIds = [...new Set(steps.flatMap((s) => s.conceptIds ?? []))];

  return {
    id: `trace:${method} ${routePath}`,
    title: humanTitle(method, routePath, trigger?.name),
    kind: "request",
    entryNodeId: trigger?.id ?? site.callerSymbolId,
    steps,
    conceptIds,
    provenance: {
      method: "heuristic",
      extractor: EXTRACTOR,
      confidence: 0.8,
      evidence: [site.ref, ...(route.location ? [route.location] : [])],
      note:
        "Composed from an extracted call-site-to-route match plus outward edge walks. " +
        "Step order reflects the framework's request pipeline, not a recorded execution.",
    },
  };
}

function findTriggeringComponent(kb: KBBuilder, fromId: string): KBNode | undefined {
  // Breadth-first over reverse `calls` edges, stopping at the first component.
  const incoming = new Map<string, string[]>();
  for (const edge of kb.allEdges()) {
    if (edge.kind !== "calls") continue;
    const list = incoming.get(edge.to) ?? [];
    list.push(edge.from);
    incoming.set(edge.to, list);
  }

  const seen = new Set<string>([fromId]);
  let frontier = [fromId];
  for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const callerId of incoming.get(id) ?? []) {
        if (seen.has(callerId)) continue;
        seen.add(callerId);
        const node = kb.getNode(callerId);
        if (node?.kind === "uiComponent") return node;
        next.push(callerId);
      }
    }
    frontier = next;
  }
  return undefined;
}

interface DataAccess {
  to: string;
  kind: "readsFrom" | "writesTo";
  note?: string;
  provenance: KBNode["provenance"];
}

function dataAccessOf(kb: KBBuilder, symbolId: string): DataAccess[] {
  const out: DataAccess[] = [];
  const seen = new Set<string>();
  for (const edge of kb.allEdges()) {
    if (edge.from !== symbolId) continue;
    if (edge.kind !== "readsFrom" && edge.kind !== "writesTo") continue;
    const key = `${edge.kind}:${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      to: edge.to,
      kind: edge.kind,
      note: edge.provenance.note,
      provenance: edge.provenance,
    });
  }
  return out;
}

function findModelByName(kb: KBBuilder, name: string): KBNode | undefined {
  const bare = name.replace(/[\[\]"']/g, "").split(".").pop() ?? name;
  const candidates = kb.nodesOfKind("dataModel").filter((n) => n.name === bare);
  // Prefer the persisted definition over a same-named client-side type.
  return candidates.find((c) => c.attrs?.persisted) ?? candidates[0];
}

function describeHooks(component: KBNode): string | undefined {
  const hooks = (component.attrs?.hooks as string[] | undefined) ?? [];
  if (hooks.length === 0) return undefined;
  const notable = hooks.filter((h) => /Query|Mutation|Suspense|Effect/.test(h));
  if (notable.length === 0) return undefined;
  return `Uses ${notable.map((h) => `\`${h}\``).join(", ")}.`;
}

function describeCacheBehaviour(component: KBNode): string | undefined {
  const hooks = (component.attrs?.hooks as string[] | undefined) ?? [];
  if (hooks.some((h) => /useSuspenseQuery/.test(h))) {
    return "The component suspends until data arrives, so it never renders a partially-loaded state; the fallback is supplied by an enclosing Suspense boundary.";
  }
  if (hooks.some((h) => /useQuery/.test(h))) {
    return "The result is cached by query key. A later mutation invalidates that key, which is what triggers a refetch rather than a manual reload.";
  }
  if (hooks.some((h) => /useMutation/.test(h))) {
    return "On success the mutation invalidates cached queries so dependent views refetch.";
  }
  return undefined;
}

function humanTitle(method: string, routePath: string, componentName?: string): string {
  const resource = routePath.split("/").filter((s) => s && !isParamSegment(s)).pop() ?? "resource";
  const noun = singular(resource);
  const verbPhrase =
    method === "GET" ? `views ${resource}`
    : method === "POST" ? `creates ${article(noun)} ${noun}`
    : method === "PUT" || method === "PATCH" ? `updates ${article(noun)} ${noun}`
    : method === "DELETE" ? `deletes ${article(noun)} ${noun}`
    : `calls ${routePath}`;
  return componentName ? `User ${verbPhrase} (from ${componentName})` : `User ${verbPhrase}`;
}

function singular(word: string): string {
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}
