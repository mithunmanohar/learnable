import path from "node:path";
import { ids, KBBuilder } from "../kb/builder.js";
import type { Provenance, SourceRef } from "../kb/types.js";
import {
  endLine, excerpt, findAll, parse, startLine, stringValue,
  type SyntaxNode,
} from "../core/parse.js";
import { readFileSafe, type WalkedFile } from "../core/walk.js";
import type { DetectedService } from "./manifests.js";

const EXTRACTOR = "python@0.1.0";
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

interface PyFile {
  file: WalkedFile;
  moduleName: string;
  serviceId: string;
  tree: SyntaxNode;
  /** local alias -> fully qualified module name, from `from x import y` / `import x` */
  imports: Map<string, string>;
}

interface RouterDef {
  key: string;
  varName: string;
  moduleName: string;
  /** Literal prefix, or an unresolved expression like `settings.API_V1_STR`. */
  prefixExpr: string;
  isApp: boolean;
  ref: SourceRef;
}

interface Mount {
  parentKey: string;
  childKey: string;
  prefixExpr: string;
}

/**
 * Extracts Python structure, with FastAPI as the first-class framework.
 *
 * The hard part is not finding `@router.get("/")` — it is working out that the
 * route's real path is `/api/v1/items/`, which is spread across three files and
 * one settings constant. Without that resolution the frontend and backend halves
 * of the knowledge base never join up, and the trace view cannot exist.
 */
export async function extractPython(
  kb: KBBuilder,
  root: string,
  files: WalkedFile[],
  services: DetectedService[],
): Promise<void> {
  const pyFiles = files.filter((f) => f.path.endsWith(".py"));
  if (pyFiles.length === 0) return;

  const parsed: PyFile[] = [];
  const allPaths = new Set(files.map((f) => f.path));

  for (const file of pyFiles) {
    const source = readFileSafe(file.absPath);
    if (!source) continue;
    const tree = await parse(source, "python");
    if (!tree) {
      kb.addDiagnostic({
        level: "warn", extractor: EXTRACTOR,
        message: "Python grammar unavailable; file skipped.", file: file.path,
      });
      continue;
    }
    const serviceId = serviceForPath(file.path, services);
    parsed.push({
      file,
      moduleName: moduleNameFor(file.path, allPaths),
      serviceId,
      tree: tree.rootNode,
      imports: collectImports(tree.rootNode),
    });
  }

  // Module-level and Settings constants, resolved across the whole service so
  // `settings.API_V1_STR` can be turned into "/api/v1".
  const constants = collectConstants(parsed);

  const routers: RouterDef[] = [];
  const mounts: Mount[] = [];

  // Models must all exist before functions are linked to them: a handler in
  // api/routes/items.py references a model defined in models.py, and file walk
  // order does not follow the dependency direction.
  for (const pf of parsed) {
    emitFileNode(kb, pf);
    collectRoutersAndMounts(pf, routers, mounts);
    extractClasses(kb, pf);
    extractEnvVars(kb, pf);
  }
  for (const pf of parsed) {
    extractFunctions(kb, pf);
  }

  const prefixes = resolveRouterPrefixes(routers, mounts, constants);
  for (const pf of parsed) {
    extractRoutes(kb, pf, routers, prefixes, constants);
  }

  const unresolved = routers.filter((r) => !prefixes.has(r.key));
  if (unresolved.length > 0) {
    kb.addDiagnostic({
      level: "gap", extractor: EXTRACTOR,
      message:
        `${unresolved.length} router(s) could not be traced to a mounted application, ` +
        `so routes on them carry a relative path only: ${unresolved.map((r) => r.key).join(", ")}.`,
    });
  }
}

/* ---------- module and service resolution ---------- */

/** Walks up while parent directories are packages, the way Python itself does. */
function moduleNameFor(filePath: string, allPaths: Set<string>): string {
  const parts = filePath.split("/");
  const fileName = parts[parts.length - 1] ?? "";
  const dirs = parts.slice(0, -1);
  let firstPackageIdx = dirs.length;
  for (let i = dirs.length - 1; i >= 0; i--) {
    const initPath = [...dirs.slice(0, i + 1), "__init__.py"].join("/");
    if (allPaths.has(initPath)) firstPackageIdx = i;
    else break;
  }
  const pkgParts = dirs.slice(firstPackageIdx);
  const stem = fileName.replace(/\.pyi?$/, "");
  const segments = stem === "__init__" ? pkgParts : [...pkgParts, stem];
  return segments.join(".");
}

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
  for (const stmt of findAll(root, ["import_from_statement", "import_statement"])) {
    if (stmt.type === "import_from_statement") {
      const moduleNode = stmt.childForFieldName("module_name");
      const base = moduleNode?.text ?? "";
      for (const name of stmt.namedChildren) {
        if (name === moduleNode) continue;
        if (name.type === "dotted_name" || name.type === "identifier") {
          const local = name.text;
          out.set(local, base ? `${base}.${local}` : local);
        } else if (name.type === "aliased_import") {
          const orig = name.childForFieldName("name")?.text ?? "";
          const alias = name.childForFieldName("alias")?.text ?? orig;
          out.set(alias, base ? `${base}.${orig}` : orig);
        }
      }
    } else {
      for (const name of stmt.namedChildren) {
        if (name.type === "dotted_name") out.set(name.text, name.text);
        else if (name.type === "aliased_import") {
          const orig = name.childForFieldName("name")?.text ?? "";
          const alias = name.childForFieldName("alias")?.text ?? orig;
          out.set(alias, orig);
        }
      }
    }
  }
  return out;
}

/* ---------- constants ---------- */

/**
 * Collects `NAME = "literal"` at module level and inside settings classes, keyed
 * both bare and as `settings.NAME`, since that is how call sites reference them.
 */
function collectConstants(parsed: PyFile[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const pf of parsed) {
    for (const assign of findAll(pf.tree, ["assignment"])) {
      const left = assign.childForFieldName("left");
      const right = assign.childForFieldName("right");
      if (!left || !right || left.type !== "identifier") continue;
      if (right.type !== "string") continue;
      const value = stringValue(right);
      if (value === undefined) continue;
      const name = left.text;
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
      out.set(name, value);
      out.set(`settings.${name}`, value);
    }
  }
  return out;
}

function resolveExpr(expr: string, constants: Map<string, string>): string | undefined {
  const trimmed = expr.trim();
  if (/^['"]/.test(trimmed)) return trimmed.replace(/^['"]|['"]$/g, "");
  return constants.get(trimmed) ?? constants.get(trimmed.replace(/^.*\./, ""));
}

/* ---------- nodes ---------- */

function emitFileNode(kb: KBBuilder, pf: PyFile): void {
  kb.addNode({
    id: ids.file(pf.file.path),
    kind: "file",
    name: path.posix.basename(pf.file.path),
    qualifiedName: pf.moduleName,
    serviceId: pf.serviceId,
    layer: layerForPath(pf.file.path),
    location: { file: pf.file.path, startLine: 1 },
    attrs: { path: pf.file.path, language: "Python", module: pf.moduleName },
    provenance: { method: "extracted", extractor: EXTRACTOR },
  });
}

function layerForPath(p: string): "api" | "data" | "domain" | "test" | "config" | "unknown" {
  if (/(^|\/)tests?\//.test(p) || /test_[^/]*\.py$/.test(p)) return "test";
  if (/(^|\/)(api|routes|routers|endpoints|views)\//.test(p)) return "api";
  if (/(models|schemas|entities|tables)\.py$/.test(p) || /(^|\/)models\//.test(p)) return "data";
  if (/(config|settings)\.py$/.test(p)) return "config";
  if (/(crud|services?|domain|repositor)/.test(p)) return "domain";
  return "unknown";
}

/** `class Item(ItemBase, table=True)` → a data model, persisted or not. */
function extractClasses(kb: KBBuilder, pf: PyFile): void {
  for (const cls of findAll(pf.tree, ["class_definition"])) {
    const nameNode = cls.childForFieldName("name");
    if (!nameNode) continue;
    const name = nameNode.text;
    const supers = cls.childForFieldName("superclasses");

    const bases: string[] = [];
    let isTable = false;
    if (supers) {
      for (const arg of supers.namedChildren) {
        if (arg.type === "keyword_argument") {
          const kw = arg.childForFieldName("name")?.text;
          const val = arg.childForFieldName("value")?.text;
          if (kw === "table" && val === "True") isTable = true;
        } else {
          bases.push(arg.text);
        }
      }
    }

    const modelBase = bases.some((b) =>
      /^(SQLModel|BaseModel|BaseSettings|Base|models\.Model)$/.test(b),
    );
    const inheritsKnownModel = bases.length > 0;
    const looksLikeModel = modelBase || isTable || inheritsKnownModel;
    if (!looksLikeModel) continue;

    const ref: SourceRef = {
      file: pf.file.path,
      startLine: startLine(cls),
      endLine: endLine(cls),
      excerpt: excerpt(cls),
    };
    const nodeId = ids.dataModel(pf.file.path, name);
    const fields = extractFields(cls);

    kb.addNode({
      id: nodeId,
      kind: "dataModel",
      name,
      qualifiedName: `${pf.moduleName}.${name}`,
      serviceId: pf.serviceId,
      layer: "data",
      location: ref,
      summary: isTable
        ? `Persisted entity backed by table \`${name.toLowerCase()}\`.`
        : `Data shape used at the API boundary; not persisted directly.`,
      tags: isTable ? ["persisted"] : ["dto"],
      attrs: {
        persisted: isTable,
        table: isTable ? name.toLowerCase() : undefined,
        baseModels: bases,
        fields,
      },
      provenance: {
        method: isTable ? "extracted" : "heuristic",
        extractor: EXTRACTOR,
        confidence: isTable ? 1 : 0.8,
        evidence: [ref],
        note: isTable
          ? "`table=True` marks this class as mapped to a database table."
          : "Class inherits a model base but declares no table; treated as a transfer object.",
      },
    });

    // Inheritance is how these codebases express "same data, different shape".
    for (const base of bases) {
      // Base classes are usually declared in the same file, but not always;
      // fall back to a name lookup so cross-file hierarchies still link.
      const baseId = kb.hasNode(ids.dataModel(pf.file.path, base))
        ? ids.dataModel(pf.file.path, base)
        : findModelNode(kb, base);
      if (!baseId) continue;
      kb.addEdge({
        from: nodeId, to: baseId, kind: "extends",
        label: `${name} extends ${base}`,
        provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
      });
      kb.addEdge({
        from: baseId, to: nodeId, kind: "transformsTo",
        label: `${base} → ${name}`,
        provenance: {
          method: "heuristic", extractor: EXTRACTOR, confidence: 0.7, evidence: [ref],
          note: "Shared base class: the same data appears in a different shape at a different layer.",
        },
      });
    }

    if (isTable) {
      const storeId = ids.datastore("primary-database");
      kb.addEdge({
        from: nodeId, to: storeId, kind: "writesTo",
        label: `table ${name.toLowerCase()}`,
        provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
      });
    }
  }
}

function extractFields(cls: SyntaxNode): { name: string; type?: string; note?: string }[] {
  const body = cls.childForFieldName("body");
  if (!body) return [];
  const out: { name: string; type?: string; note?: string }[] = [];
  for (const stmt of body.namedChildren) {
    if (stmt.type !== "expression_statement") continue;
    const assign = stmt.namedChildren[0];
    if (!assign || assign.type !== "assignment") continue;
    const left = assign.childForFieldName("left");
    const typeNode = assign.childForFieldName("type");
    if (!left || left.type !== "identifier" || !typeNode) continue;
    const right = assign.childForFieldName("right")?.text;
    out.push({
      name: left.text,
      type: typeNode.text,
      note: right && right.includes("primary_key=True") ? "primary key"
        : right && right.includes("unique=True") ? "unique"
        : right && right.includes("foreign_key=") ? "foreign key"
        : undefined,
    });
  }
  return out;
}

function extractFunctions(kb: KBBuilder, pf: PyFile): void {
  for (const fn of findAll(pf.tree, ["function_definition"])) {
    const nameNode = fn.childForFieldName("name");
    if (!nameNode) continue;
    const name = nameNode.text;
    if (name.startsWith("__")) continue;

    const cls = enclosingClass(fn);
    const qualified = cls ? `${pf.moduleName}.${cls}.${name}` : `${pf.moduleName}.${name}`;
    const ref: SourceRef = {
      file: pf.file.path, startLine: startLine(fn), endLine: endLine(fn), excerpt: excerpt(fn),
    };
    const isAsync = fn.parent?.text.startsWith("async") || fn.text.startsWith("async");
    const symbolId = ids.symbol(pf.file.path, name);

    kb.addNode({
      id: symbolId,
      kind: "symbol",
      name,
      qualifiedName: qualified,
      serviceId: pf.serviceId,
      layer: layerForPath(pf.file.path),
      location: ref,
      summary: docstringOf(fn),
      attrs: {
        symbolKind: cls ? "method" : "function",
        async: Boolean(isAsync),
        params: paramsOf(fn),
        returns: fn.childForFieldName("return_type")?.text,
      },
      provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
    });

    kb.addEdge({
      from: symbolId, to: ids.file(pf.file.path), kind: "definedIn",
      provenance: { method: "extracted", extractor: EXTRACTOR },
    });

    linkDataAccess(kb, pf, fn, symbolId);
  }
}

/**
 * ORM usage inside a function body, turned into readsFrom/writesTo edges.
 * These are what let a trace say "this handler reads the item table" without a
 * language model guessing.
 */
function linkDataAccess(kb: KBBuilder, pf: PyFile, fn: SyntaxNode, symbolId: string): void {
  const locals = localModelBindings(fn);

  for (const call of findAll(fn, ["call"])) {
    const fnNode = call.childForFieldName("function");
    if (!fnNode) continue;
    const callee = fnNode.text;
    const args = call.childForFieldName("arguments");
    const ref: SourceRef = {
      file: pf.file.path, startLine: startLine(call), endLine: endLine(call), excerpt: excerpt(call),
    };

    const readVerb = /(^|\.)select$/.test(callee) || /\.(get|exec|query|scalars|refresh)$/.test(callee);
    const writeVerb = /\.(add|delete|merge|bulk_save_objects)$/.test(callee);
    if (!readVerb && !writeVerb) continue;

    const modelName = firstIdentifierArg(args, locals);
    if (!modelName) continue;

    const target = findModelNode(kb, modelName);
    if (!target) continue;

    kb.addEdge({
      from: symbolId, to: target, kind: writeVerb ? "writesTo" : "readsFrom",
      label: callee,
      provenance: {
        method: "extracted", extractor: EXTRACTOR, evidence: [ref],
        note: `ORM call \`${callee}\` referencing model \`${modelName}\`.`,
      },
    });
  }
}

function findModelNode(kb: KBBuilder, modelName: string): string | undefined {
  for (const node of kb.nodesOfKind("dataModel")) {
    if (node.name === modelName) return node.id;
  }
  return undefined;
}

function firstIdentifierArg(
  args: SyntaxNode | null,
  locals: Map<string, string>,
): string | undefined {
  if (!args) return undefined;
  for (const arg of args.namedChildren) {
    if (arg.type === "identifier") {
      // `select(Item)` names the model directly; `session.add(item)` names a
      // local that was built from one, so fall back to the binding map.
      if (/^[A-Z]/.test(arg.text)) return arg.text;
      const bound = locals.get(arg.text);
      if (bound) return bound;
    }
    if (arg.type === "attribute") {
      const obj = arg.childForFieldName("object");
      if (obj && /^[A-Z]/.test(obj.text)) return obj.text;
      if (obj && locals.has(obj.text)) return locals.get(obj.text);
    }
  }
  return undefined;
}

/**
 * Maps local names to the model they hold, within one function.
 *
 * Two sources cover almost all real handler code: a typed parameter
 * (`db_user: User`) and an assignment from a model constructor or classmethod
 * (`item = Item.model_validate(...)`). Without this, the write step of every
 * create/update trace goes missing, because ORM writes are issued against a
 * local variable rather than the model class.
 */
function localModelBindings(fn: SyntaxNode): Map<string, string> {
  const out = new Map<string, string>();

  for (const param of paramsOf(fn)) {
    if (!param.type) continue;
    const bare = param.type.replace(/^\s*|\s*$/g, "").replace(/\|.*$/, "").trim();
    if (/^[A-Z]\w*$/.test(bare)) out.set(param.name, bare);
  }

  for (const assign of findAll(fn, ["assignment"])) {
    const left = assign.childForFieldName("left");
    const right = assign.childForFieldName("right");
    if (!left || left.type !== "identifier" || !right || right.type !== "call") continue;
    const callee = right.childForFieldName("function");
    if (!callee) continue;
    if (callee.type === "identifier" && /^[A-Z]/.test(callee.text)) {
      out.set(left.text, callee.text);
    } else if (callee.type === "attribute") {
      const obj = callee.childForFieldName("object")?.text;
      if (obj && /^[A-Z]\w*$/.test(obj)) out.set(left.text, obj);
    }
  }

  return out;
}

function enclosingClass(fn: SyntaxNode): string | undefined {
  let cur: SyntaxNode | null = fn.parent;
  while (cur) {
    if (cur.type === "class_definition") return cur.childForFieldName("name")?.text;
    cur = cur.parent;
  }
  return undefined;
}

function docstringOf(fn: SyntaxNode): string | undefined {
  const body = fn.childForFieldName("body");
  const first = body?.namedChildren[0];
  if (first?.type !== "expression_statement") return undefined;
  const str = first.namedChildren[0];
  if (str?.type !== "string") return undefined;
  const value = stringValue(str) ?? str.text;
  const cleaned = value.replace(/^\s+|\s+$/g, "").split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
  return cleaned.length > 0 ? cleaned : undefined;
}

function paramsOf(fn: SyntaxNode): { name: string; type?: string }[] {
  const params = fn.childForFieldName("parameters");
  if (!params) return [];
  const out: { name: string; type?: string }[] = [];
  for (const p of params.namedChildren) {
    if (p.type === "identifier") out.push({ name: p.text });
    else if (p.type === "typed_parameter" || p.type === "typed_default_parameter") {
      const name = p.namedChildren.find((c) => c.type === "identifier")?.text;
      const type = p.childForFieldName("type")?.text;
      if (name) out.push({ name, type });
    } else if (p.type === "default_parameter") {
      const name = p.childForFieldName("name")?.text;
      if (name) out.push({ name });
    }
  }
  return out.filter((p) => p.name !== "self");
}

/* ---------- routers, mounts, routes ---------- */

function collectRoutersAndMounts(pf: PyFile, routers: RouterDef[], mounts: Mount[]): void {
  for (const assign of findAll(pf.tree, ["assignment"])) {
    const left = assign.childForFieldName("left");
    const right = assign.childForFieldName("right");
    if (!left || !right || left.type !== "identifier" || right.type !== "call") continue;
    const callee = right.childForFieldName("function")?.text ?? "";
    const isRouter = /(^|\.)APIRouter$/.test(callee);
    const isApp = /(^|\.)(FastAPI|Flask)$/.test(callee);
    if (!isRouter && !isApp) continue;

    const kwargs = keywordArgs(right.childForFieldName("arguments"));
    routers.push({
      key: `${pf.moduleName}.${left.text}`,
      varName: left.text,
      moduleName: pf.moduleName,
      prefixExpr: kwargs.get("prefix")?.text ?? "",
      isApp,
      ref: { file: pf.file.path, startLine: startLine(assign), excerpt: excerpt(assign) },
    });
  }

  for (const call of findAll(pf.tree, ["call"])) {
    const fnNode = call.childForFieldName("function");
    if (!fnNode || fnNode.type !== "attribute") continue;
    if (fnNode.childForFieldName("attribute")?.text !== "include_router") continue;
    const parentVar = fnNode.childForFieldName("object")?.text;
    if (!parentVar) continue;

    const args = call.childForFieldName("arguments");
    const positional = args?.namedChildren.filter((c) => c.type !== "keyword_argument") ?? [];
    const childExpr = positional[0]?.text;
    if (!childExpr) continue;

    mounts.push({
      parentKey: `${pf.moduleName}.${parentVar}`,
      childKey: qualifyRouterExpr(childExpr, pf),
      prefixExpr: keywordArgs(args).get("prefix")?.text ?? "",
    });
  }
}

/** `items.router` in module `app.api.main` → `app.api.routes.items.router`. */
function qualifyRouterExpr(expr: string, pf: PyFile): string {
  const parts = expr.split(".");
  if (parts.length === 1) {
    // A bare name is usually imported from where it was defined
    // (`from app.api.main import api_router`), so the import map, not the
    // current module, gives the key the definition was registered under.
    return pf.imports.get(expr) ?? `${pf.moduleName}.${expr}`;
  }
  const head = parts[0] ?? "";
  const rest = parts.slice(1).join(".");
  const resolvedModule = pf.imports.get(head);
  return resolvedModule ? `${resolvedModule}.${rest}` : `${pf.moduleName}.${expr}`;
}

function keywordArgs(args: SyntaxNode | null): Map<string, SyntaxNode> {
  const out = new Map<string, SyntaxNode>();
  if (!args) return out;
  for (const arg of args.namedChildren) {
    if (arg.type !== "keyword_argument") continue;
    const name = arg.childForFieldName("name")?.text;
    const value = arg.childForFieldName("value");
    if (name && value) out.set(name, value);
  }
  return out;
}

/** Walks the mount tree so every router knows its absolute prefix. */
function resolveRouterPrefixes(
  routers: RouterDef[],
  mounts: Mount[],
  constants: Map<string, string>,
): Map<string, string> {
  const byKey = new Map(routers.map((r) => [r.key, r]));
  const parentOf = new Map<string, { parent: string; prefix: string }>();
  for (const m of mounts) {
    parentOf.set(m.childKey, { parent: m.parentKey, prefix: m.prefixExpr });
  }

  const resolved = new Map<string, string>();
  const resolve = (key: string, seen: Set<string>): string | undefined => {
    if (resolved.has(key)) return resolved.get(key);
    if (seen.has(key)) return undefined; // cyclic mount, give up rather than hang
    seen.add(key);

    const router = byKey.get(key);
    if (!router) return undefined;

    const own = resolveExpr(router.prefixExpr, constants) ?? "";
    if (router.isApp) {
      resolved.set(key, own);
      return own;
    }

    const link = parentOf.get(key);
    if (!link) {
      // Never mounted: the route path is only meaningful relative to this router.
      return undefined;
    }
    const mountPrefix = resolveExpr(link.prefix, constants) ?? "";
    const parentPrefix = resolve(link.parent, seen);
    if (parentPrefix === undefined) return undefined;

    const full = joinPath(parentPrefix, mountPrefix, own);
    resolved.set(key, full);
    return full;
  };

  for (const r of routers) resolve(r.key, new Set());
  return resolved;
}

function joinPath(...parts: string[]): string {
  const joined = parts
    .filter((p) => p !== "")
    .map((p) => (p.startsWith("/") ? p : `/${p}`))
    .join("");
  return joined.replace(/\/{2,}/g, "/");
}

function extractRoutes(
  kb: KBBuilder,
  pf: PyFile,
  routers: RouterDef[],
  prefixes: Map<string, string>,
  constants: Map<string, string>,
): void {
  for (const dec of findAll(pf.tree, ["decorated_definition"])) {
    const fn = dec.namedChildren.find((c) => c.type === "function_definition");
    if (!fn) continue;
    const handlerName = fn.childForFieldName("name")?.text;
    if (!handlerName) continue;

    for (const decorator of dec.namedChildren.filter((c) => c.type === "decorator")) {
      const call = decorator.namedChildren.find((c) => c.type === "call");
      if (!call) continue;
      const target = call.childForFieldName("function");
      if (!target || target.type !== "attribute") continue;

      const verb = target.childForFieldName("attribute")?.text?.toLowerCase();
      const routerVar = target.childForFieldName("object")?.text;
      if (!verb || !routerVar || !HTTP_VERBS.has(verb)) continue;

      const args = call.childForFieldName("arguments");
      const positional = args?.namedChildren.filter((c) => c.type !== "keyword_argument") ?? [];
      const localPath = stringValue(positional[0]) ?? "/";
      const kwargs = keywordArgs(args);

      const routerKey = `${pf.moduleName}.${routerVar}`;
      const base = prefixes.get(routerKey);
      const routerDef = routers.find((r) => r.key === routerKey);
      const ownPrefix = routerDef ? resolveExpr(routerDef.prefixExpr, constants) ?? "" : "";

      const fullPath = base !== undefined
        ? normalisePath(joinPath(base, localPath))
        : normalisePath(joinPath(ownPrefix, localPath));

      const ref: SourceRef = {
        file: pf.file.path,
        startLine: startLine(decorator),
        endLine: endLine(fn),
        excerpt: excerpt(decorator),
      };

      const responseModel = kwargs.get("response_model")?.text;
      const params = paramsOf(fn);
      const requestModel = params.find((p) =>
        p.type && /(Create|Update|Register|Base|Public|In)$/.test(p.type),
      )?.type;
      const auth = detectAuth(params, kwargs);

      const routeId = ids.route(verb, fullPath);
      const handlerId = ids.symbol(pf.file.path, handlerName);

      kb.addNode({
        id: routeId,
        kind: "route",
        name: `${verb.toUpperCase()} ${fullPath}`,
        serviceId: pf.serviceId,
        layer: "api",
        location: ref,
        summary: docstringOf(fn),
        tags: auth ? ["authenticated"] : ["public"],
        attrs: {
          method: verb.toUpperCase(),
          path: fullPath,
          localPath,
          pathResolved: base !== undefined,
          handlerId,
          requestModel,
          responseModel,
          auth,
        },
        provenance: {
          method: base !== undefined ? "extracted" : "heuristic",
          extractor: EXTRACTOR,
          confidence: base !== undefined ? 1 : 0.5,
          evidence: [ref, ...(routerDef ? [routerDef.ref] : [])],
          note: base !== undefined
            ? "Full path composed by following the include_router mount chain to the application object."
            : "Router was never mounted in the scanned source, so this path may be missing a prefix.",
        },
      });

      kb.addEdge({
        from: routeId, to: handlerId, kind: "handles",
        label: handlerName,
        provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
      });

      if (responseModel) {
        const modelId = findModelNode(kb, responseModel);
        if (modelId) {
          kb.addEdge({
            from: routeId, to: modelId, kind: "validates",
            label: `response_model=${responseModel}`,
            provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
          });
        }
      }
    }
  }
}

function detectAuth(
  params: { name: string; type?: string }[],
  kwargs: Map<string, SyntaxNode>,
): string | undefined {
  const dep = kwargs.get("dependencies")?.text ?? "";
  if (/get_current_active_superuser/.test(dep)) return "superuser";
  if (/get_current_user|CurrentUser/.test(dep)) return "user";
  const typed = params.find((p) => p.type && /CurrentUser|CurrentActiveUser/.test(p.type));
  if (typed) return "user";
  return undefined;
}

/** FastAPI treats a trailing slash as significant; keep it, it is part of the path. */
function normalisePath(p: string): string {
  if (p === "") return "/";
  return p.replace(/\/{2,}/g, "/");
}

/* ---------- configuration surface ---------- */

function extractEnvVars(kb: KBBuilder, pf: PyFile): void {
  // Explicit os.environ / os.getenv reads.
  for (const call of findAll(pf.tree, ["call"])) {
    const callee = call.childForFieldName("function")?.text ?? "";
    if (!/(os\.getenv|environ\.get)$/.test(callee)) continue;
    const first = call.childForFieldName("arguments")?.namedChildren[0];
    const key = stringValue(first);
    if (key) emitEnvVar(kb, pf, key, call, false);
  }
  for (const sub of findAll(pf.tree, ["subscript"])) {
    const value = sub.childForFieldName("value")?.text ?? "";
    if (!/environ$/.test(value)) continue;
    const key = stringValue(sub.childForFieldName("subscript"));
    if (key) emitEnvVar(kb, pf, key, sub, true);
  }

  // pydantic-settings: every field of a BaseSettings class is an env var, and a
  // field with no default is a required one. This is the config surface a reader
  // needs before they can run the thing.
  for (const cls of findAll(pf.tree, ["class_definition"])) {
    const supers = cls.childForFieldName("superclasses")?.text ?? "";
    if (!/BaseSettings/.test(supers)) continue;
    const body = cls.childForFieldName("body");
    if (!body) continue;
    for (const stmt of body.namedChildren) {
      if (stmt.type !== "expression_statement") continue;
      const assign = stmt.namedChildren[0];
      if (!assign || assign.type !== "assignment") continue;
      const left = assign.childForFieldName("left");
      const typeNode = assign.childForFieldName("type");
      if (!left || left.type !== "identifier" || !typeNode) continue;
      const hasDefault = Boolean(assign.childForFieldName("right"));
      emitEnvVar(kb, pf, left.text, assign, !hasDefault, typeNode.text);
    }
  }
}

function emitEnvVar(
  kb: KBBuilder, pf: PyFile, key: string, node: SyntaxNode, required: boolean, type?: string,
): void {
  const ref: SourceRef = {
    file: pf.file.path, startLine: startLine(node), excerpt: excerpt(node),
  };
  kb.addNode({
    id: ids.envVar(key),
    kind: "envVar",
    name: key,
    layer: "config",
    location: ref,
    tags: required ? ["required"] : ["optional"],
    attrs: { key, required, type },
    provenance: {
      method: "extracted", extractor: EXTRACTOR, evidence: [ref],
      note: required
        ? "Declared with no default: the application will not start without it."
        : undefined,
    },
  });
  kb.addEdge({
    from: ids.file(pf.file.path), to: ids.envVar(key), kind: "configures",
    provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
  });
}
