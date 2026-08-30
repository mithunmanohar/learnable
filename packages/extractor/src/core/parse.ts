import { createRequire } from "node:module";
import path from "node:path";
import Parser from "web-tree-sitter";

const require = createRequire(import.meta.url);

/**
 * Language-agnostic parsing via tree-sitter compiled to WebAssembly.
 *
 * WASM rather than native bindings on purpose: no compiler toolchain on the
 * user's machine, no node-gyp, identical behaviour on every platform. Adding a
 * language later is a grammar file, not a rebuild.
 *
 * Version pin matters: tree-sitter-wasms@0.1.13 grammars are built against the
 * 0.22.x runtime ABI. web-tree-sitter >= 0.24 rejects them with an opaque empty
 * error from its dylink loader, so both versions are pinned exactly.
 */

export type LanguageId =
  | "typescript" | "tsx" | "javascript" | "python" | "go" | "java"
  | "ruby" | "rust" | "php" | "c_sharp" | "yaml" | "json" | "hcl";

const EXT_TO_LANG: Record<string, LanguageId> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "tsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".java": "java",
  ".rb": "ruby",
  ".rs": "rust",
  ".php": "php",
  ".cs": "c_sharp",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
};

export function languageForFile(file: string): LanguageId | undefined {
  return EXT_TO_LANG[path.extname(file).toLowerCase()];
}

/** Human-facing language name, used for the repo language histogram. */
export function displayLanguage(lang: LanguageId): string {
  switch (lang) {
    case "tsx": return "TypeScript";
    case "typescript": return "TypeScript";
    case "javascript": return "JavaScript";
    case "c_sharp": return "C#";
    default: return lang.charAt(0).toUpperCase() + lang.slice(1);
  }
}

let initialised = false;
const languageCache = new Map<LanguageId, Parser.Language>();

async function ensureInit(): Promise<void> {
  if (initialised) return;
  await Parser.init();
  initialised = true;
}

function grammarPath(lang: LanguageId): string {
  const pkg = require.resolve("tree-sitter-wasms/package.json");
  return path.join(path.dirname(pkg), "out", `tree-sitter-${lang}.wasm`);
}

export async function loadLanguage(lang: LanguageId): Promise<Parser.Language | undefined> {
  await ensureInit();
  const cached = languageCache.get(lang);
  if (cached) return cached;
  try {
    const loaded = await Parser.Language.load(grammarPath(lang));
    languageCache.set(lang, loaded);
    return loaded;
  } catch {
    return undefined;
  }
}

export async function parse(source: string, lang: LanguageId): Promise<Parser.Tree | undefined> {
  const language = await loadLanguage(lang);
  if (!language) return undefined;
  const parser = new Parser();
  parser.setLanguage(language);
  return parser.parse(source);
}

/* ---------- syntax-tree helpers used by every extractor ---------- */

export type SyntaxNode = Parser.SyntaxNode;

/** Depth-first walk over every node in the tree. */
export function* walkTree(node: SyntaxNode): Generator<SyntaxNode> {
  yield node;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) yield* walkTree(child);
  }
}

/** All descendants of one of the given types. */
export function findAll(root: SyntaxNode, types: string[]): SyntaxNode[] {
  const wanted = new Set(types);
  const out: SyntaxNode[] = [];
  for (const n of walkTree(root)) if (wanted.has(n.type)) out.push(n);
  return out;
}

/** Nearest ancestor of one of the given types, or undefined. */
export function ancestorOfType(node: SyntaxNode, types: string[]): SyntaxNode | undefined {
  const wanted = new Set(types);
  let cur: SyntaxNode | null = node.parent;
  while (cur) {
    if (wanted.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

/** 1-based start line, matching how editors and SourceRef count. */
export function startLine(node: SyntaxNode): number { return node.startPosition.row + 1; }
export function endLine(node: SyntaxNode): number { return node.endPosition.row + 1; }

/** Trimmed single-line excerpt suitable for a citation. */
export function excerpt(node: SyntaxNode, maxLen = 200): string {
  const text = node.text.split("\n")[0]?.trim() ?? "";
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

/** Strips quotes from a tree-sitter string literal node. */
export function stringValue(node: SyntaxNode | null | undefined): string | undefined {
  if (!node) return undefined;
  const text = node.text;
  // Triple quotes must be tested first: a single-quote pattern matches a
  // docstring's outer characters and leaves the inner pair behind.
  const triple = /^[rbfu]*("""|''')([\s\S]*)\1$/i.exec(text);
  if (triple) return triple[2];
  const m = /^[rbfu]*(['"`])([\s\S]*)\1$/i.exec(text);
  if (m) return m[2];
  // Python string nodes wrap their content in `string_content`.
  const content = node.namedChildren.find((c) => c.type === "string_content");
  return content ? content.text : undefined;
}
