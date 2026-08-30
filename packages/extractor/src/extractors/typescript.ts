import path from "node:path";
import { ids, KBBuilder, type HttpCallSite } from "../kb/builder.js";
import type { SourceRef } from "../kb/types.js";
import {
  endLine, excerpt, findAll, parse, startLine, stringValue,
  type LanguageId, type SyntaxNode,
} from "../core/parse.js";
import { readFileSafe, type WalkedFile } from "../core/walk.js";
import type { DetectedService } from "./manifests.js";

const EXTRACTOR = "typescript@0.1.0";
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
const FUNCTION_NODES = new Set([
  "function_declaration", "function_expression", "arrow_function",
  "method_definition", "generator_function_declaration",
]);

interface TsFile {
  file: WalkedFile;
  lang: LanguageId;
  serviceId: string;
  tree: SyntaxNode;
  /** local binding -> module specifier */
  imports: Map<string, string>;
  source: string;
}

export async function extractTypeScript(
  kb: KBBuilder,
  root: string,
  files: WalkedFile[],
  services: DetectedService[],
): Promise<void> {
  const tsFiles = files.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f.path));
  if (tsFiles.length === 0) return;

  const parsed: TsFile[] = [];
  for (const file of tsFiles) {
    const source = readFileSafe(file.absPath);
    if (!source) continue;
    const lang: LanguageId = /\.(tsx|jsx)$/.test(file.path)
      ? "tsx"
      : /\.(ts|mts|cts)$/.test(file.path) ? "typescript" : "javascript";
    const tree = await parse(source, lang);
    if (!tree) {
      kb.addDiagnostic({
        level: "warn", extractor: EXTRACTOR,
        message: `Grammar for ${lang} unavailable; file skipped.`, file: file.path,
      });
      continue;
    }
    parsed.push({
      file, lang, source,
      serviceId: serviceForPath(file.path, services),
      tree: tree.rootNode,
      imports: collectImports(tree.rootNode),
    });
  }

  for (const tf of parsed) {
    emitFileNode(kb, tf);
    extractTypes(kb, tf);
    extractSymbolsAndComponents(kb, tf);
  }

  // Symbol index for name-based call resolution. Built after all files are
  // walked so a call can resolve to a definition later in the scan order.
  const symbolIndex = buildSymbolIndex(kb);

  const callSites: HttpCallSite[] = [];
  for (const tf of parsed) {
    extractCallsAndRoutes(kb, tf, symbolIndex, callSites);
    extractEnvVars(kb, tf);
  }

  // Stash for the trace synthesiser, which needs both halves of the stack.
  kb.httpCallSites = callSites;

  extractPrismaSchema(kb, files);
}

/* ---------- shared helpers ---------- */

function serviceForPath(filePath: string, services: DetectedService[]): string {
  let best = "";
  for (const svc of services) {
    if (svc.root === "" || filePath.startsWith(`${svc.root}/`)) {
      if (svc.root.length >= best.length) best = svc.root;
    }
  }
  return ids.service(best);
}

function collectImports(root: SyntaxNode): Map<string, string> {
  const out = new Map<string, string>();
  for (const imp of findAll(root, ["import_statement"])) {
    const source = stringValue(imp.childForFieldName("source"));
    if (!source) continue;
    for (const spec of findAll(imp, ["import_specifier", "namespace_import", "identifier"])) {
      const name = spec.type === "import_specifier"
        ? (spec.childForFieldName("alias") ?? spec.childForFieldName("name"))?.text
        : spec.text;
      if (name) out.set(name, source);
    }
  }
  return out;
}

function layerForPath(p: string): "ui" | "client" | "api" | "data" | "test" | "config" | "build" | "unknown" {
  if (/(^|\/)(tests?|__tests__|e2e)\//.test(p) || /\.(test|spec)\.[tj]sx?$/.test(p)) return "test";
  if (/(^|\/)(routes|pages|app|views|screens)\//.test(p)) return "ui";
  if (/(^|\/)components?\//.test(p)) return "ui";
  if (/(^|\/)(client|api|services?|sdk)\//.test(p)) return "client";
  if (/(^|\/)(models|schemas?|entities|db)\//.test(p)) return "data";
  if (/\.config\.[tj]s$/.test(p)) return "build";
  if (/(^|\/)hooks?\//.test(p)) return "ui";
  return "unknown";
}

function emitFileNode(kb: KBBuilder, tf: TsFile): void {
  kb.addNode({
    id: ids.file(tf.file.path),
    kind: "file",
    name: path.posix.basename(tf.file.path),
    serviceId: tf.serviceId,
    layer: layerForPath(tf.file.path),
    location: { file: tf.file.path, startLine: 1 },
    attrs: {
      path: tf.file.path,
      language: tf.lang === "javascript" ? "JavaScript" : "TypeScript",
      generated: /\.gen\.[tj]sx?$/.test(tf.file.path) || tf.source.includes("This file is auto-generated"),
    },
    provenance: { method: "extracted", extractor: EXTRACTOR },
  });
}

/* ---------- type declarations as data shapes ---------- */

function extractTypes(kb: KBBuilder, tf: TsFile): void {
  for (const decl of findAll(tf.tree, ["interface_declaration", "type_alias_declaration"])) {
    const name = decl.childForFieldName("name")?.text;
    if (!name) continue;
    const ref: SourceRef = {
      file: tf.file.path, startLine: startLine(decl), endLine: endLine(decl), excerpt: excerpt(decl),
    };
    kb.addNode({
      id: ids.dataModel(tf.file.path, name),
      kind: "dataModel",
      name,
      serviceId: tf.serviceId,
      layer: "client",
      location: ref,
      tags: ["wire"],
      attrs: {
        persisted: false,
        declaration: decl.type === "interface_declaration" ? "interface" : "type",
        fields: extractTypeMembers(decl),
      },
      provenance: {
        method: "extracted", extractor: EXTRACTOR, evidence: [ref],
        note: "Client-side type describing the shape of data on the wire.",
      },
    });
  }
}

function extractTypeMembers(decl: SyntaxNode): { name: string; type?: string }[] {
  const out: { name: string; type?: string }[] = [];
  for (const sig of findAll(decl, ["property_signature"])) {
    const name = sig.childForFieldName("name")?.text;
    if (!name) continue;
    const type = sig.childForFieldName("type")?.text?.replace(/^:\s*/, "");
    out.push({ name, type });
    if (out.length >= 60) break;
  }
  return out;
}

/* ---------- symbols and React components ---------- */

function extractSymbolsAndComponents(kb: KBBuilder, tf: TsFile): void {
  const declarations = findAll(tf.tree, [
    "function_declaration", "class_declaration", "variable_declarator", "method_definition",
  ]);

  for (const decl of declarations) {
    const nameNode = decl.childForFieldName("name");
    const name = nameNode?.text;
    if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;

    const ref: SourceRef = {
      file: tf.file.path, startLine: startLine(decl), endLine: endLine(decl), excerpt: excerpt(decl),
    };

    const body = decl.childForFieldName("value") ?? decl.childForFieldName("body") ?? decl;
    const rendersJsx = findAll(body, ["jsx_element", "jsx_self_closing_element", "jsx_fragment"]).length > 0;
    const isComponent = rendersJsx && /^[A-Z]/.test(name);

    if (isComponent) {
      const routePath = detectRoutePath(tf, decl);
      const componentId = ids.component(tf.file.path, name);
      kb.addNode({
        id: componentId,
        kind: "uiComponent",
        name,
        serviceId: tf.serviceId,
        layer: "ui",
        location: ref,
        summary: routePath
          ? `Page component rendered at \`${routePath}\`.`
          : `Presentational component.`,
        tags: routePath ? ["page"] : [],
        attrs: {
          isPage: Boolean(routePath),
          routePath,
          hooks: hooksUsed(body),
        },
        provenance: {
          method: "heuristic", extractor: EXTRACTOR, confidence: 0.9, evidence: [ref],
          note: "Capitalised declaration that returns JSX.",
        },
      });
      kb.addEdge({
        from: componentId, to: ids.file(tf.file.path), kind: "definedIn",
        provenance: { method: "extracted", extractor: EXTRACTOR },
      });
      linkRenderedComponents(kb, tf, body, componentId);
      continue;
    }

    // Skip trivial local bindings; keep functions and classes.
    const isFunctionLike = FUNCTION_NODES.has(decl.type)
      || decl.type === "class_declaration"
      || (decl.childForFieldName("value") && FUNCTION_NODES.has(decl.childForFieldName("value")!.type));
    if (!isFunctionLike) continue;

    const symbolId = ids.symbol(tf.file.path, name);
    kb.addNode({
      id: symbolId,
      kind: "symbol",
      name,
      serviceId: tf.serviceId,
      layer: layerForPath(tf.file.path),
      location: ref,
      attrs: {
        symbolKind: decl.type === "class_declaration" ? "class"
          : decl.type === "method_definition" ? "method" : "function",
      },
      provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
    });
    kb.addEdge({
      from: symbolId, to: ids.file(tf.file.path), kind: "definedIn",
      provenance: { method: "extracted", extractor: EXTRACTOR },
    });
  }
}

/** File-based routers announce themselves; both common conventions are handled. */
function detectRoutePath(tf: TsFile, decl: SyntaxNode): string | undefined {
  for (const call of findAll(tf.tree, ["call_expression"])) {
    const callee = call.childForFieldName("function")?.text ?? "";
    if (!/createFileRoute|createLazyFileRoute/.test(callee)) continue;
    const arg = call.childForFieldName("arguments")?.namedChildren[0];
    const value = stringValue(arg);
    if (value) return value;
  }
  // Next.js app router: app/dashboard/page.tsx -> /dashboard
  const m = /(^|\/)app\/(.*)\/page\.[tj]sx?$/.exec(tf.file.path);
  if (m?.[2] !== undefined) {
    return `/${m[2].replace(/\(.*?\)\//g, "").replace(/\[([^\]]+)\]/g, ":$1")}`;
  }
  return undefined;
}

function hooksUsed(body: SyntaxNode): string[] {
  const out = new Set<string>();
  for (const call of findAll(body, ["call_expression"])) {
    const callee = call.childForFieldName("function")?.text ?? "";
    const base = callee.split(".").pop() ?? "";
    if (/^use[A-Z]/.test(base)) out.add(base);
  }
  return [...out];
}

function linkRenderedComponents(kb: KBBuilder, tf: TsFile, body: SyntaxNode, componentId: string): void {
  const seen = new Set<string>();
  for (const el of findAll(body, ["jsx_opening_element", "jsx_self_closing_element"])) {
    const nameNode = el.childForFieldName("name");
    const name = nameNode?.text;
    if (!name || !/^[A-Z]/.test(name) || seen.has(name)) continue;
    seen.add(name);
    const source = tf.imports.get(name);
    // A specifier carries no extension, so try each candidate and keep the one
    // that actually produced a node rather than guessing wrong and dangling.
    const candidates = source
      ? resolveImportCandidates(tf.file.path, source)
      : [tf.file.path];
    const targetId = candidates
      .map((f) => ids.component(f, name))
      .find((id) => kb.hasNode(id));
    if (!targetId) continue;
    kb.addEdge({
      from: componentId, to: targetId, kind: "renders",
      label: `<${name} />`,
      provenance: {
        method: "heuristic", extractor: EXTRACTOR, confidence: 0.85,
        evidence: [{ file: tf.file.path, startLine: startLine(el), excerpt: excerpt(el) }],
      },
    });
  }
}

/**
 * Resolves a module specifier to a repo path. Handles relative imports and the
 * `@/` alias, which is near-universal in generated frontends. Bare package
 * specifiers return undefined — they are dependencies, not files.
 */
function resolveImport(fromFile: string, spec: string): string | undefined {
  return resolveImportCandidates(fromFile, spec)[0];
}

/**
 * Every path a module specifier could denote, most likely first. Module
 * specifiers omit the extension and may name a directory's index file, so a
 * single guess dangles often enough to matter.
 */
function resolveImportCandidates(fromFile: string, spec: string): string[] {
  const exts = [".ts", ".tsx", ".js", ".jsx"];
  let base: string;
  if (spec.startsWith(".")) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  } else if (spec.startsWith("@/")) {
    const srcRoot = /(^|.*\/)src\//.exec(fromFile)?.[0];
    if (!srcRoot) return [];
    base = path.posix.normalize(`${srcRoot}${spec.slice(2)}`);
  } else {
    return [];
  }
  if (exts.some((ext) => base.endsWith(ext))) return [base];
  return [
    ...exts.map((ext) => `${base}${ext}`),
    ...exts.map((ext) => `${base}/index${ext}`),
  ];
}

/* ---------- calls, route definitions, HTTP call sites ---------- */

function buildSymbolIndex(kb: KBBuilder): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const node of kb.allNodes()) {
    if (node.kind !== "symbol" && node.kind !== "uiComponent") continue;
    const list = index.get(node.name) ?? [];
    list.push(node.id);
    index.set(node.name, list);
  }
  return index;
}

function extractCallsAndRoutes(
  kb: KBBuilder,
  tf: TsFile,
  symbolIndex: Map<string, string[]>,
  callSites: HttpCallSite[],
): void {
  for (const call of findAll(tf.tree, ["call_expression"])) {
    const calleeNode = call.childForFieldName("function");
    if (!calleeNode) continue;
    const callee = calleeNode.text;
    const args = call.childForFieldName("arguments");
    const argNodes = args?.namedChildren ?? [];
    const ref: SourceRef = {
      file: tf.file.path, startLine: startLine(call), endLine: endLine(call), excerpt: excerpt(call),
    };

    const member = calleeNode.type === "member_expression" ? calleeNode : undefined;
    const verb = member?.childForFieldName("property")?.text?.toLowerCase();
    const receiver = member?.childForFieldName("object")?.text ?? "";

    if (verb && HTTP_VERBS.has(verb)) {
      const first = argNodes[0];
      const firstString = stringValue(first);
      const lastArg = argNodes[argNodes.length - 1];
      const lastIsHandler = Boolean(lastArg && (FUNCTION_NODES.has(lastArg.type) || lastArg.type === "identifier"));

      // `app.get('/items', handler)` defines a route.
      if (firstString && argNodes.length >= 2 && lastIsHandler) {
        emitNodeRoute(kb, tf, verb, firstString, ref, lastArg!);
        continue;
      }
      // `client.get({ url: '/api/v1/items/' })` or `axios.get('/api/v1/items/')` calls one.
      const urlFromObject = first && first.type === "object" ? objectStringProp(first, "url") : undefined;
      const url = urlFromObject ?? (firstString && /^(https?:|\/)/.test(firstString) ? firstString : undefined);
      if (url) {
        const enclosing = enclosingSymbol(tf, call);
        callSites.push({
          method: verb.toUpperCase(), url,
          callerSymbolId: enclosing.id, callerName: enclosing.name,
          file: tf.file.path, ref,
        });
        continue;
      }
    }

    // Bare fetch('/api/x', { method: 'POST' })
    if (callee === "fetch" || callee.endsWith(".fetch")) {
      const url = stringValue(argNodes[0]);
      if (url && /^(https?:|\/)/.test(url)) {
        const config = argNodes[1];
        const method = (config && config.type === "object" ? objectStringProp(config, "method") : undefined) ?? "GET";
        const enclosing = enclosingSymbol(tf, call);
        callSites.push({
          method: method.toUpperCase(), url,
          callerSymbolId: enclosing.id, callerName: enclosing.name,
          file: tf.file.path, ref,
        });
      }
      continue;
    }

    // Ordinary intra-repo calls, used to walk from a page to its data layer.
    const targetName = callee.includes(".") ? callee.split(".").pop()! : callee;
    if (!/^[a-zA-Z_$][\w$]*$/.test(targetName)) continue;
    const candidates = symbolIndex.get(targetName);
    if (!candidates || candidates.length === 0) continue;
    // Prefer a definition in a file this one imports; fall back to a unique match.
    const target = pickCallTarget(tf, candidates, receiver);
    if (!target) continue;
    const enclosing = enclosingSymbol(tf, call);
    if (enclosing.id === target) continue;
    kb.addEdge({
      from: enclosing.id, to: target, kind: "calls",
      label: targetName,
      provenance: {
        method: "heuristic", extractor: EXTRACTOR,
        confidence: candidates.length === 1 ? 0.9 : 0.6,
        evidence: [ref],
        note: candidates.length === 1
          ? "Unique symbol name across the scanned repository."
          : `Name resolves to ${candidates.length} candidates; nearest import chosen.`,
      },
    });
  }
}

function pickCallTarget(tf: TsFile, candidates: string[], receiver: string): string | undefined {
  if (candidates.length === 1) return candidates[0];
  const importedFrom = tf.imports.get(receiver);
  if (importedFrom) {
    const resolved = resolveImport(tf.file.path, importedFrom);
    if (resolved) {
      const match = candidates.find((c) => c.startsWith(`symbol:${resolved.replace(/\.tsx?$/, "")}`));
      if (match) return match;
    }
  }
  const sameFile = candidates.find((c) => c.startsWith(`symbol:${tf.file.path}#`));
  return sameFile ?? candidates[0];
}

function objectStringProp(obj: SyntaxNode, key: string): string | undefined {
  for (const pair of obj.namedChildren) {
    if (pair.type !== "pair") continue;
    const k = pair.childForFieldName("key")?.text?.replace(/['"]/g, "");
    if (k !== key) continue;
    return stringValue(pair.childForFieldName("value"));
  }
  return undefined;
}

function enclosingSymbol(tf: TsFile, node: SyntaxNode): { id: string; name: string } {
  let cur: SyntaxNode | null = node.parent;
  while (cur) {
    if (FUNCTION_NODES.has(cur.type) || cur.type === "class_declaration") {
      const name = cur.childForFieldName("name")?.text
        ?? (cur.parent?.type === "variable_declarator"
          ? cur.parent.childForFieldName("name")?.text
          : undefined);
      if (name) {
        const isComponent = /^[A-Z]/.test(name)
          && findAll(cur, ["jsx_element", "jsx_self_closing_element", "jsx_fragment"]).length > 0;
        return {
          id: isComponent ? ids.component(tf.file.path, name) : ids.symbol(tf.file.path, name),
          name,
        };
      }
    }
    cur = cur.parent;
  }
  return { id: ids.file(tf.file.path), name: path.posix.basename(tf.file.path) };
}

function emitNodeRoute(
  kb: KBBuilder, tf: TsFile, verb: string, routePath: string, ref: SourceRef, handler: SyntaxNode,
): void {
  const routeId = ids.route(verb, routePath);
  kb.addNode({
    id: routeId,
    kind: "route",
    name: `${verb.toUpperCase()} ${routePath}`,
    serviceId: tf.serviceId,
    layer: "api",
    location: ref,
    attrs: { method: verb.toUpperCase(), path: routePath, pathResolved: true },
    provenance: {
      method: "heuristic", extractor: EXTRACTOR, confidence: 0.85, evidence: [ref],
      note: "String path plus a handler argument; the shape of an Express/Fastify route definition.",
    },
  });
  const handlerName = handler.type === "identifier" ? handler.text : undefined;
  if (handlerName) {
    kb.addEdge({
      from: routeId, to: ids.symbol(tf.file.path, handlerName), kind: "handles",
      provenance: { method: "heuristic", extractor: EXTRACTOR, confidence: 0.8, evidence: [ref] },
    });
  }
}

/* ---------- config surface ---------- */

function extractEnvVars(kb: KBBuilder, tf: TsFile): void {
  for (const member of findAll(tf.tree, ["member_expression"])) {
    const text = member.text;
    const m = /(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]*)/.exec(text);
    if (!m?.[1]) continue;
    const key = m[1];
    const ref: SourceRef = { file: tf.file.path, startLine: startLine(member), excerpt: excerpt(member) };
    kb.addNode({
      id: ids.envVar(key),
      kind: "envVar",
      name: key,
      layer: "config",
      location: ref,
      attrs: { key, required: false },
      provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
    });
    kb.addEdge({
      from: ids.file(tf.file.path), to: ids.envVar(key), kind: "configures",
      provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
    });
  }
}

/* ---------- Prisma ---------- */

/**
 * Prisma keeps its models in its own DSL rather than in TypeScript, so it needs
 * a separate reader. Common enough in agent-generated Node stacks to be worth it.
 */
function extractPrismaSchema(kb: KBBuilder, files: WalkedFile[]): void {
  for (const file of files) {
    if (!file.path.endsWith(".prisma")) continue;
    const source = readFileSafe(file.absPath);
    if (!source) continue;

    const lines = source.split("\n");
    let current: { name: string; startLine: number; fields: { name: string; type?: string; note?: string }[] } | undefined;

    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] ?? "").trim();
      const modelMatch = /^model\s+(\w+)\s*\{/.exec(line);
      if (modelMatch?.[1]) {
        current = { name: modelMatch[1], startLine: i + 1, fields: [] };
        continue;
      }
      if (!current) continue;
      if (line === "}") {
        const ref: SourceRef = { file: file.path, startLine: current.startLine, endLine: i + 1 };
        kb.addNode({
          id: ids.dataModel(file.path, current.name),
          kind: "dataModel",
          name: current.name,
          layer: "data",
          location: ref,
          summary: `Persisted entity defined in the Prisma schema.`,
          tags: ["persisted"],
          attrs: { persisted: true, table: current.name.toLowerCase(), fields: current.fields },
          provenance: { method: "extracted", extractor: "prisma@0.1.0", evidence: [ref] },
        });
        kb.addEdge({
          from: ids.dataModel(file.path, current.name),
          to: ids.datastore("primary-database"),
          kind: "writesTo",
          provenance: { method: "extracted", extractor: "prisma@0.1.0", evidence: [ref] },
        });
        current = undefined;
        continue;
      }
      const fieldMatch = /^(\w+)\s+([\w\[\]?]+)(.*)$/.exec(line);
      if (fieldMatch?.[1] && fieldMatch[2]) {
        current.fields.push({
          name: fieldMatch[1],
          type: fieldMatch[2],
          note: /@id/.test(fieldMatch[3] ?? "") ? "primary key"
            : /@unique/.test(fieldMatch[3] ?? "") ? "unique"
            : /@relation/.test(fieldMatch[3] ?? "") ? "relation"
            : undefined,
        });
      }
    }
  }
}
