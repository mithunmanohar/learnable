import path from "node:path";
import { ids, KBBuilder } from "../kb/builder.js";
import type { SourceRef } from "../kb/types.js";
import { readFileSafe, type WalkedFile } from "../core/walk.js";

const EXTRACTOR = "terraform@0.2.0";

/**
 * Terraform configuration.
 *
 * Parsed by brace-depth block scanning rather than a real HCL grammar: no
 * tree-sitter HCL grammar ships with the WASM set, and block structure plus
 * attribute references — which is all this needs — are recoverable without one.
 * Attribute *values* are deliberately not evaluated, so nothing interpolated is
 * reported rather than being reported wrongly.
 *
 * The valuable output is not the resource list. It is the edges: Terraform
 * builds its dependency graph implicitly, from one block referencing another
 * block's attribute, and that graph is invisible to a reader who does not
 * already know to look for it.
 */
export function extractTerraform(kb: KBBuilder, files: WalkedFile[]): void {
  const tfFiles = files.filter((f) => f.path.endsWith(".tf"));
  if (tfFiles.length === 0) return;

  interface Block {
    nodeId: string;
    /** Address as written in HCL, e.g. `aws_eks_cluster.this`, `module.eks`. */
    address: string;
    /** Directory the block lives in. Terraform addresses are scoped to their
     *  module, so the same address in two directories is two different things. */
    moduleDir: string;
    file: string;
    startLine: number;
    body: string;
  }
  const blocks: Block[] = [];
  let sawBackend = false;

  for (const file of tfFiles) {
    const raw = readFileSafe(file.absPath);
    if (!raw) continue;
    const lines = raw.split("\n");
    const moduleDir = path.posix.dirname(file.path);

    for (const block of scanBlocks(raw)) {
      const startLine = raw.slice(0, block.headerIndex).split("\n").length;
      const ref: SourceRef = {
        file: file.path,
        startLine,
        endLine: startLine + block.body.split("\n").length,
        excerpt: (lines[startLine - 1] ?? "").trim(),
      };

      const [kind, ...labels] = block.header;
      if (!kind) continue;

      switch (kind) {
        case "resource": {
          const [type, name] = labels;
          if (!type || !name) break;
          const address = `${type}.${name}`;
          const provider = type.split("_")[0] ?? "terraform";
          const nodeId = ids.infra(provider, `${moduleDir}/${address}`);
          kb.addNode({
            id: nodeId,
            kind: "infraResource",
            name: address,
            qualifiedName: `${moduleDir}/${address}`,
            layer: "infra",
            location: ref,
            summary: `Terraform-managed ${type}.`,
            tags: lifecycleTags(block.body),
            attrs: {
              provider, resourceType: type, iac: "terraform", blockType: "resource",
              count: /^\s*count\s*=/m.test(block.body) || undefined,
              forEach: /^\s*for_each\s*=/m.test(block.body) || undefined,
            },
            provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
          });
          blocks.push({ nodeId, address, moduleDir, file: file.path, startLine, body: block.body });
          break;
        }
        case "data": {
          const [type, name] = labels;
          if (!type || !name) break;
          const address = `data.${type}.${name}`;
          const provider = type.split("_")[0] ?? "terraform";
          const nodeId = ids.infra(provider, `${moduleDir}/${address}`);
          kb.addNode({
            id: nodeId,
            kind: "infraResource",
            name: address,
            qualifiedName: `${moduleDir}/${address}`,
            layer: "infra",
            location: ref,
            summary: `Reads an existing ${type} that this configuration does not own.`,
            tags: ["data-source"],
            attrs: { provider, resourceType: type, iac: "terraform", blockType: "data" },
            provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
          });
          blocks.push({ nodeId, address, moduleDir, file: file.path, startLine, body: block.body });
          break;
        }
        case "module": {
          const [name] = labels;
          if (!name) break;
          const address = `module.${name}`;
          const nodeId = ids.module(`${moduleDir}/${address}`);
          const source = attrValue(block.body, "source");
          kb.addNode({
            id: nodeId,
            kind: "module",
            name: address,
            layer: "infra",
            location: ref,
            summary: source
              ? `Composed module from \`${source}\`. Most of what it creates is not visible in this repository.`
              : "Composed module.",
            attrs: {
              path: file.path, iac: "terraform", blockType: "module",
              source, version: attrValue(block.body, "version"),
              registry: source ? !source.startsWith(".") : undefined,
            },
            provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
          });
          blocks.push({ nodeId, address, moduleDir, file: file.path, startLine, body: block.body });
          break;
        }
        case "variable": {
          const [name] = labels;
          if (!name) break;
          const hasDefault = /^\s*default\s*=/m.test(block.body);
          kb.addNode({
            id: `envVar:tfvar:${moduleDir}/${name}`,
            kind: "envVar",
            name,
            layer: "config",
            location: ref,
            tags: hasDefault ? ["tf-variable", "optional"] : ["tf-variable", "required"],
            attrs: {
              key: name, kind: "terraform-variable", required: !hasDefault,
              type: attrValue(block.body, "type"),
              description: attrValue(block.body, "description"),
              sensitive: /^\s*sensitive\s*=\s*true/m.test(block.body) || undefined,
            },
            provenance: {
              method: "extracted", extractor: EXTRACTOR, evidence: [ref],
              note: hasDefault ? undefined : "No default: this must be supplied by the caller.",
            },
          });
          break;
        }
        case "terraform": {
          const backend = /backend\s+"([^"]+)"/.exec(block.body)?.[1];
          if (backend) {
            sawBackend = true;
            kb.addNode({
              id: ids.infra("terraform", `backend.${backend}`),
              kind: "infraResource",
              name: `${backend} backend`,
              layer: "infra",
              location: ref,
              summary:
                `State is stored in a ${backend} backend. State maps declared resources to real ` +
                `cloud object ids, and it contains resource attributes in plaintext, so access to ` +
                `it is a security boundary.`,
              tags: ["state"],
              attrs: {
                provider: "terraform", resourceType: "backend", backend,
                locking: /dynamodb_table|use_lockfile/.test(block.body) || undefined,
              },
              provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
            });
          }
          break;
        }
        default:
          break;
      }
    }
  }

  // Second pass: the implicit dependency graph.
  const byAddress = new Map(blocks.map((b) => [`${b.moduleDir}::${b.address}`, b]));
  let edgeCount = 0;
  for (const block of blocks) {
    for (const target of referencedAddresses(block.body)) {
      if (target === block.address) continue;
      // Resolve within the same directory only: a reference in modules/karpenter
      // means the block of that address in modules/karpenter, never the root's.
      const dep = byAddress.get(`${block.moduleDir}::${target}`);
      if (!dep) continue;
      kb.addEdge({
        from: block.nodeId, to: dep.nodeId, kind: "dependsOn",
        label: target,
        provenance: {
          method: "extracted", extractor: EXTRACTOR,
          evidence: [{ file: block.file, startLine: block.startLine }],
          note:
            "Implicit dependency: this block reads an attribute of that one, which is how " +
            "Terraform orders its graph without anyone writing depends_on.",
        },
      });
      edgeCount++;
    }
  }

  if (blocks.length > 0 && edgeCount === 0) {
    kb.addDiagnostic({
      level: "gap", extractor: EXTRACTOR,
      message: "Terraform blocks were found but none reference each other, so no dependency graph could be built.",
    });
  }
  if (!sawBackend && tfFiles.length > 0) {
    kb.addDiagnostic({
      level: "gap", extractor: EXTRACTOR,
      message:
        "No backend block was found. State may be local, or configured out-of-band via -backend-config, " +
        "which cannot be determined from the repository alone.",
    });
  }

  kb.addStackItem({
    id: "stack:terraform",
    name: "Terraform",
    category: "iac",
    role: "Declares infrastructure as version-controlled configuration.",
    conceptIds: ["concept.infrastructure-as-code"],
    provenance: {
      method: "extracted", extractor: EXTRACTOR,
      evidence: [{ file: tfFiles[0]!.path, startLine: 1 }],
    },
  });
}

/* ---------- HCL block scanning ---------- */

interface ScannedBlock {
  header: string[];
  body: string;
  headerIndex: number;
}

/**
 * Yields top-level blocks with their bodies, tracking brace depth so nested
 * blocks stay inside their parent's body rather than being reported separately.
 * Strings and comments are skipped so a brace inside either does not derail it.
 */
function* scanBlocks(source: string): Generator<ScannedBlock> {
  const headerRe = /^[ \t]*([a-z_]+)((?:[ \t]+"[^"]*")*)[ \t]*\{/gm;
  let match: RegExpExecArray | null;

  while ((match = headerRe.exec(source)) !== null) {
    const kind = match[1];
    if (!kind) continue;
    const labels = [...(match[2] ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
    const openIndex = match.index + match[0].length - 1;
    const end = matchingBrace(source, openIndex);
    if (end === -1) continue;

    yield {
      header: [kind, ...labels],
      body: source.slice(openIndex + 1, end),
      headerIndex: match.index,
    };
    // Resume after this block so nested blocks are not emitted as top level.
    headerRe.lastIndex = end;
  }
}

function matchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i];

    if (ch === "#" || (ch === "/" && source[i + 1] === "/")) {
      const nl = source.indexOf("\n", i);
      if (nl === -1) return -1;
      i = nl + 1;
      continue;
    }
    // Heredocs routinely carry JSON policies, whose braces are content.
    const heredoc = /^<<-?([A-Za-z_]\w*)/.exec(source.slice(i, i + 32));
    if (heredoc?.[1]) {
      const end = new RegExp(`^[ \\t]*${heredoc[1]}\\b`, "m").exec(source.slice(i));
      i = end ? i + end.index + end[0].length : source.length;
      continue;
    }
    if (ch === '"') {
      i = skipString(source, i);
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Returns the index just past a quoted string starting at `i`.
 *
 * HCL strings may contain `${...}` interpolations, and those may contain
 * further strings — `"[${join(", ", x)}]"` is one string, not three. Scanning
 * naively for the next quote ends it at the wrong place, and the braces that
 * follow then desynchronise block detection for the rest of the file.
 */
function skipString(source: string, i: number): number {
  i++; // opening quote
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === '"') return i + 1;
    if (ch === "$" && source[i + 1] === "{") {
      i = skipInterpolation(source, i + 1);
      continue;
    }
    i++;
  }
  return i;
}

/** Returns the index just past the `}` closing an interpolation opened at `i`. */
function skipInterpolation(source: string, i: number): number {
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"') { i = skipString(source, i); continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

/** Addresses this block reads: `aws_x.y`, `data.aws_x.y`, `module.z`. */
function referencedAddresses(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\bdata\.([a-z][a-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_-]*)/g)) {
    out.add(`data.${m[1]}.${m[2]}`);
  }
  // Strip data references first so their resource-shaped tail is not re-matched.
  const withoutData = body.replace(/\bdata\.[a-z][a-z0-9_]*\.[A-Za-z_][A-Za-z0-9_-]*/g, " ");
  for (const m of withoutData.matchAll(/\bmodule\.([A-Za-z_][A-Za-z0-9_-]*)/g)) {
    out.add(`module.${m[1]}`);
  }
  for (const m of withoutData.matchAll(/\b([a-z][a-z0-9]*_[a-z0-9_]+)\.([A-Za-z_][A-Za-z0-9_-]*)/g)) {
    const type = m[1] ?? "";
    // `var.x`, `local.y` and `each.value` are not resource addresses.
    if (/^(var|local|each|count|self|path|terraform)$/.test(type)) continue;
    out.add(`${type}.${m[2]}`);
  }
  return [...out];
}

function attrValue(body: string, name: string): string | undefined {
  const re = new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, "m");
  const raw = re.exec(body)?.[1]?.trim();
  if (!raw) return undefined;
  const quoted = /^"([^"]*)"/.exec(raw);
  if (quoted) return quoted[1];
  // Unquoted values are expressions; report the literal text only when short.
  return raw.length <= 60 ? raw : undefined;
}

function lifecycleTags(body: string): string[] {
  const tags: string[] = [];
  if (/prevent_destroy\s*=\s*true/.test(body)) tags.push("prevent-destroy");
  if (/ignore_changes\s*=/.test(body)) tags.push("ignore-changes");
  if (/create_before_destroy\s*=\s*true/.test(body)) tags.push("create-before-destroy");
  return tags;
}
