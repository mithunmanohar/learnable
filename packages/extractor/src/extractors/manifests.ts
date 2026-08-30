import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { ids, KBBuilder } from "../kb/builder.js";
import type { Provenance, StackCategory } from "../kb/types.js";
import type { WalkedFile } from "../core/walk.js";
import { readFileSafe } from "../core/walk.js";

const EXTRACTOR = "manifests@0.1.0";

export interface DetectedService {
  id: string;
  /** Repo-relative directory, "" for the repo root. */
  root: string;
  name: string;
  ecosystem: "npm" | "pypi" | "go" | "cargo";
  language: string;
  framework?: string;
  /** Manifest filename, relative to `root`. Used as the citation for every fact here. */
  manifestFile: string;
  dependencies: Map<string, { version?: string; dev: boolean }>;
}

/**
 * A service is a directory that declares its own dependencies. That is a better
 * boundary than "top-level folder" because it is the unit that gets built,
 * versioned and deployed independently — which is what a reader needs to know.
 */
export function extractManifests(
  kb: KBBuilder,
  root: string,
  files: WalkedFile[],
): DetectedService[] {
  const services: DetectedService[] = [];

  for (const file of files) {
    const base = path.posix.basename(file.path);
    const dir = path.posix.dirname(file.path) === "." ? "" : path.posix.dirname(file.path);

    // A manifest nested inside another package's directory tree is usually a
    // fixture or an example; only treat reasonably shallow ones as services.
    if (dir.split("/").filter(Boolean).length > 3) continue;

    if (base === "package.json") {
      const svc = parsePackageJson(file, dir);
      if (svc) services.push(svc);
    } else if (base === "pyproject.toml") {
      const svc = parsePyproject(file, dir);
      if (svc) services.push(svc);
    } else if (base === "requirements.txt") {
      const svc = parseRequirements(file, dir);
      if (svc) services.push(svc);
    } else if (base === "go.mod") {
      const svc = parseGoMod(file, dir);
      if (svc) services.push(svc);
    }
  }

  // Deduplicate: a directory with both pyproject.toml and requirements.txt is
  // one service, and pyproject is the richer source.
  const byRoot = new Map<string, DetectedService>();
  for (const svc of services) {
    const existing = byRoot.get(svc.root);
    if (!existing || svc.dependencies.size > existing.dependencies.size) {
      byRoot.set(svc.root, svc);
    }
  }
  const deduped = [...byRoot.values()];

  for (const svc of deduped) {
    svc.framework = inferFramework(svc);
    kb.addNode({
      id: svc.id,
      kind: "service",
      name: svc.name,
      layer: guessServiceLayer(svc),
      location: { file: manifestPathFor(svc), startLine: 1 },
      summary: svc.framework
        ? `${svc.language} service built on ${svc.framework}.`
        : `${svc.language} package.`,
      attrs: {
        root: svc.root,
        ecosystem: svc.ecosystem,
        language: svc.language,
        framework: svc.framework,
        dependencyCount: svc.dependencies.size,
      },
      provenance: {
        method: "extracted",
        extractor: EXTRACTOR,
        evidence: [{ file: manifestPathFor(svc), startLine: 1 }],
      },
    });

    for (const [name, meta] of svc.dependencies) {
      const depId = ids.dependency(svc.ecosystem, name);
      kb.addNode({
        id: depId,
        kind: "dependency",
        name,
        layer: "build",
        attrs: { ecosystem: svc.ecosystem, version: meta.version, dev: meta.dev },
        provenance: {
          method: "extracted",
          extractor: EXTRACTOR,
          evidence: [{ file: manifestPathFor(svc), startLine: 1 }],
        },
      });
      kb.addEdge({
        from: svc.id,
        to: depId,
        kind: "dependsOn",
        attrs: { dev: meta.dev },
        provenance: { method: "extracted", extractor: EXTRACTOR },
      });

      const classified = classifyDependency(name, svc.ecosystem);
      if (classified) {
        kb.addStackItem({
          id: `stack:${name}`,
          name,
          version: meta.version,
          category: classified.category,
          role: classified.role,
          serviceIds: [svc.id],
          conceptIds: classified.conceptIds,
          provenance: {
            method: "extracted",
            extractor: EXTRACTOR,
            evidence: [{ file: manifestPathFor(svc), startLine: 1 }],
          },
        });
      }
    }

    kb.addStackItem({
      id: `stack:lang:${svc.language}`,
      name: svc.language,
      category: "language",
      role: `Implementation language for ${svc.name}.`,
      serviceIds: [svc.id],
      provenance: {
        method: "extracted",
        extractor: EXTRACTOR,
        evidence: [{ file: manifestPathFor(svc), startLine: 1 }],
      },
    });
  }

  return deduped;
}

function manifestPathFor(svc: DetectedService): string {
  return svc.root ? `${svc.root}/${svc.manifestFile}` : svc.manifestFile;
}

/* ---------- per-ecosystem manifest parsing ---------- */

function parsePackageJson(file: WalkedFile, dir: string): DetectedService | undefined {
  const raw = readFileSafe(file.absPath);
  if (!raw) return undefined;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const deps = new Map<string, { version?: string; dev: boolean }>();
  for (const [k, v] of Object.entries((pkg.dependencies as Record<string, string>) ?? {})) {
    deps.set(k, { version: v, dev: false });
  }
  for (const [k, v] of Object.entries((pkg.devDependencies as Record<string, string>) ?? {})) {
    if (!deps.has(k)) deps.set(k, { version: v, dev: true });
  }
  return {
    id: ids.service(dir),
    root: dir,
    name: (pkg.name as string) ?? (dir || "root"),
    ecosystem: "npm",
    language: "TypeScript/JavaScript",
    dependencies: deps,
    manifestFile: "package.json",
  };
}

function parsePyproject(file: WalkedFile, dir: string): DetectedService | undefined {
  const raw = readFileSafe(file.absPath);
  if (!raw) return undefined;
  let toml: Record<string, any>;
  try {
    toml = parseToml(raw) as Record<string, any>;
  } catch {
    return undefined;
  }

  const deps = new Map<string, { version?: string; dev: boolean }>();

  // PEP 621
  for (const spec of (toml.project?.dependencies as string[]) ?? []) {
    const parsed = parsePep508(spec);
    if (parsed) deps.set(parsed.name, { version: parsed.version, dev: false });
  }
  for (const group of Object.values(
    (toml["dependency-groups"] as Record<string, string[]>) ?? {},
  )) {
    for (const spec of group ?? []) {
      const parsed = parsePep508(spec);
      if (parsed && !deps.has(parsed.name)) deps.set(parsed.name, { version: parsed.version, dev: true });
    }
  }
  // Poetry
  for (const [name, val] of Object.entries(
    (toml.tool?.poetry?.dependencies as Record<string, unknown>) ?? {},
  )) {
    if (name.toLowerCase() === "python") continue;
    deps.set(name, { version: typeof val === "string" ? val : undefined, dev: false });
  }

  return {
    id: ids.service(dir),
    root: dir,
    name: (toml.project?.name as string) ?? (toml.tool?.poetry?.name as string) ?? (dir || "root"),
    ecosystem: "pypi",
    language: "Python",
    dependencies: deps,
    manifestFile: "pyproject.toml",
  };
}

function parseRequirements(file: WalkedFile, dir: string): DetectedService | undefined {
  const raw = readFileSafe(file.absPath);
  if (!raw) return undefined;
  const deps = new Map<string, { version?: string; dev: boolean }>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
    const parsed = parsePep508(trimmed);
    if (parsed) deps.set(parsed.name, { version: parsed.version, dev: false });
  }
  if (deps.size === 0) return undefined;
  return {
    id: ids.service(dir),
    root: dir,
    name: dir || "root",
    ecosystem: "pypi",
    language: "Python",
    dependencies: deps,
    manifestFile: "requirements.txt",
  };
}

function parseGoMod(file: WalkedFile, dir: string): DetectedService | undefined {
  const raw = readFileSafe(file.absPath);
  if (!raw) return undefined;
  const deps = new Map<string, { version?: string; dev: boolean }>();
  const moduleName = /^module\s+(\S+)/m.exec(raw)?.[1];
  const requireBlock = /require\s*\(([\s\S]*?)\)/m.exec(raw)?.[1];
  const lines = requireBlock ? requireBlock.split("\n") : raw.split("\n").filter((l) => l.includes("require "));
  for (const line of lines) {
    const m = /^\s*(?:require\s+)?([\w.\-/]+)\s+(v\S+)/.exec(line);
    if (m?.[1] && m[2]) deps.set(m[1], { version: m[2], dev: false });
  }
  return {
    id: ids.service(dir),
    root: dir,
    name: moduleName ?? (dir || "root"),
    ecosystem: "go",
    language: "Go",
    dependencies: deps,
    manifestFile: "go.mod",
  };
}

/** Parses `name[extra]>=1.2,<2` down to its distribution name and version spec. */
function parsePep508(spec: string): { name: string; version?: string } | undefined {
  const cleaned = spec.split(";")[0]?.trim() ?? "";
  const m = /^([A-Za-z0-9._-]+)\s*(\[[^\]]*\])?\s*(.*)$/.exec(cleaned);
  if (!m?.[1]) return undefined;
  const version = m[3]?.trim();
  return { name: m[1], version: version ? version : undefined };
}

/* ---------- dependency → stack classification ---------- */

interface StackClass {
  category: StackCategory;
  role: string;
  conceptIds?: string[];
}

/**
 * Curated rather than exhaustive. The point is not to name every package but to
 * answer "what are the load-bearing choices in this system", which is a much
 * shorter list — and to attach the concepts each choice drags in with it.
 */
const STACK_TABLE: [RegExp, StackClass][] = [
  [/^react$/, { category: "frontend-framework", role: "Declarative UI rendering with a virtual DOM.", conceptIds: ["concept.declarative-ui"] }],
  [/^(vue|svelte|solid-js|preact)$/, { category: "frontend-framework", role: "Component-based UI framework." }],
  [/^next$/, { category: "frontend-framework", role: "React framework with file-based routing and server rendering.", conceptIds: ["concept.server-side-rendering"] }],
  [/^@?tanstack\/(react-)?router$/, { category: "routing", role: "Type-safe client-side routing.", conceptIds: ["concept.client-side-routing"] }],
  [/^react-router/, { category: "routing", role: "Client-side routing." }],
  [/^@?tanstack\/(react-)?query$/, { category: "data-fetching", role: "Server-state cache: fetching, caching and invalidation for remote data.", conceptIds: ["concept.server-state-cache", "concept.cache-invalidation"] }],
  [/^(swr|apollo-client|@apollo\/client|urql)$/, { category: "data-fetching", role: "Remote data fetching and caching." }],
  [/^(redux|@reduxjs\/toolkit|zustand|jotai|mobx|recoil)$/, { category: "state-management", role: "Client-side application state." }],
  [/^(tailwindcss|styled-components|@emotion\/react|sass)$/, { category: "styling", role: "Styling system." }],
  [/^(@chakra-ui\/react|@mui\/material|antd|@radix-ui\/.*|shadcn.*)$/, { category: "ui-library", role: "Component library." }],
  [/^(vite|webpack|rollup|esbuild|parcel|turbopack)$/, { category: "build", role: "Bundler and dev server." }],
  [/^(vitest|jest|@playwright\/test|playwright|cypress|pytest.*|mocha)$/, { category: "test", role: "Test runner." }],
  [/^(eslint|prettier|biome|@biomejs\/biome|ruff|mypy|black)$/, { category: "lint", role: "Static checking and formatting." }],
  [/^typescript$/, { category: "language", role: "Static typing over JavaScript.", conceptIds: ["concept.static-typing"] }],
  [/^zod$/, { category: "validation", role: "Runtime schema validation at the trust boundary.", conceptIds: ["concept.boundary-validation"] }],

  [/^fastapi$/, { category: "backend-framework", role: "Async Python HTTP framework with typed request/response models.", conceptIds: ["concept.boundary-validation", "concept.dependency-injection"] }],
  [/^(flask|django|starlette|litestar)$/, { category: "backend-framework", role: "Python HTTP framework." }],
  [/^(express|fastify|@nestjs\/core|koa|hono)$/, { category: "backend-framework", role: "Node HTTP framework." }],
  [/^uvicorn$/, { category: "runtime", role: "ASGI server that actually runs the Python app." }],
  [/^(gunicorn|hypercorn)$/, { category: "runtime", role: "Application server process manager." }],

  [/^(sqlmodel|sqlalchemy)$/, { category: "orm", role: "Maps Python classes to relational tables and builds queries.", conceptIds: ["concept.orm-mapping", "concept.n-plus-one"] }],
  [/^(prisma|@prisma\/client|drizzle-orm|typeorm|sequelize|mongoose)$/, { category: "orm", role: "Object/relational mapping." }],
  [/^alembic$/, { category: "orm", role: "Schema migrations, versioning the database alongside the code.", conceptIds: ["concept.schema-migration"] }],
  [/^(psycopg.*|asyncpg|pg|postgres)$/, { category: "database", role: "PostgreSQL driver." }],
  [/^(redis|ioredis)$/, { category: "cache", role: "In-memory store for caching and ephemeral state.", conceptIds: ["concept.cache-invalidation"] }],
  [/^(celery|bullmq|rq|kombu)$/, { category: "queue", role: "Background job processing.", conceptIds: ["concept.idempotency", "concept.at-least-once-delivery"] }],

  [/^(passlib|bcrypt|argon2.*)$/, { category: "auth", role: "Password hashing.", conceptIds: ["concept.password-hashing"] }],
  [/^(python-jose|pyjwt|jsonwebtoken|jose)$/, { category: "auth", role: "Signs and verifies JWTs for stateless auth.", conceptIds: ["concept.stateless-auth"] }],
  [/^(pydantic|pydantic-settings)$/, { category: "validation", role: "Parses and validates untrusted input into typed objects.", conceptIds: ["concept.boundary-validation", "concept.config-as-code"] }],
  [/^(sentry-sdk|@sentry\/.*|opentelemetry.*)$/, { category: "observability", role: "Error and trace collection." }],
];

export function classifyDependency(name: string, _ecosystem: string): StackClass | undefined {
  const lower = name.toLowerCase();
  for (const [re, cls] of STACK_TABLE) {
    if (re.test(lower)) return cls;
  }
  return undefined;
}

function inferFramework(svc: DetectedService): string | undefined {
  const names = [...svc.dependencies.keys()].map((n) => n.toLowerCase());
  const order = ["fastapi", "django", "flask", "next", "@nestjs/core", "express", "fastify", "react", "vue", "svelte"];
  for (const candidate of order) {
    if (names.includes(candidate)) return candidate;
  }
  return undefined;
}

function guessServiceLayer(svc: DetectedService): "ui" | "api" | "unknown" {
  const names = [...svc.dependencies.keys()].map((n) => n.toLowerCase());
  if (names.some((n) => ["react", "vue", "svelte", "next"].includes(n))) return "ui";
  if (names.some((n) => ["fastapi", "django", "flask", "express", "fastify", "@nestjs/core"].includes(n))) return "api";
  return "unknown";
}
