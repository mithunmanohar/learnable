import path from "node:path";
import YAML from "yaml";
import { ids, KBBuilder } from "../kb/builder.js";
import type { SourceRef } from "../kb/types.js";
import { readFileSafe, type WalkedFile } from "../core/walk.js";

const EXTRACTOR = "infra@0.1.0";

/**
 * Deployment topology: what actually runs, and what it talks to.
 *
 * This is the layer that is hardest to learn by reading application code,
 * because none of it is visible from inside the app — the database hostname is
 * an environment variable and the fact that it is a container on the same
 * network is written down only here.
 */
export function extractInfra(kb: KBBuilder, root: string, files: WalkedFile[]): void {
  for (const file of files) {
    const base = path.posix.basename(file.path);
    // Terraform and GitHub Actions have their own extractors; this handles the
    // container and Kubernetes surfaces.
    if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(base)) extractCompose(kb, file);
    else if (base === "Dockerfile" || /\.dockerfile$/i.test(base)) extractDockerfile(kb, file);
    else if (/\.ya?ml$/.test(base) && !file.path.includes(".github/")) extractKubernetes(kb, file);
  }
}

/* ---------- docker compose ---------- */

const IMAGE_ENGINES: [RegExp, { engine: string; category: "database" | "cache" | "queue" | "other" }][] = [
  [/^postgres/, { engine: "PostgreSQL", category: "database" }],
  [/^mysql|^mariadb/, { engine: "MySQL", category: "database" }],
  [/^mongo/, { engine: "MongoDB", category: "database" }],
  [/^redis/, { engine: "Redis", category: "cache" }],
  [/^rabbitmq/, { engine: "RabbitMQ", category: "queue" }],
  [/^(confluentinc\/cp-)?kafka/, { engine: "Kafka", category: "queue" }],
  [/^elasticsearch|^opensearch/, { engine: "Elasticsearch", category: "other" }],
  [/^minio/, { engine: "MinIO", category: "other" }],
];

function extractCompose(kb: KBBuilder, file: WalkedFile): void {
  const raw = readFileSafe(file.absPath);
  if (!raw) return;
  let doc: Record<string, any>;
  try {
    doc = YAML.parse(raw) as Record<string, any>;
  } catch {
    kb.addDiagnostic({
      level: "warn", extractor: EXTRACTOR,
      message: "Compose file could not be parsed as YAML.", file: file.path,
    });
    return;
  }
  const services = doc?.services;
  if (!services || typeof services !== "object") return;

  const lines = raw.split("\n");
  for (const [name, spec] of Object.entries(services as Record<string, any>)) {
    const startLine = findLine(lines, new RegExp(`^\\s{2}${escapeRe(name)}\\s*:`)) ?? 1;
    const ref: SourceRef = { file: file.path, startLine };
    const image = typeof spec?.image === "string" ? spec.image : undefined;
    const known = image ? IMAGE_ENGINES.find(([re]) => re.test(image))?.[1] : undefined;

    const nodeId = known
      ? ids.datastore(name)
      : ids.infra("compose", name);

    kb.addNode({
      id: nodeId,
      kind: known ? "datastore" : "infraResource",
      name,
      layer: known ? "data" : "infra",
      location: ref,
      summary: known
        ? `${known.engine} running as a container in the local compose stack.`
        : image
          ? `Container from image \`${image}\`.`
          : `Container built from source in this repository.`,
      attrs: {
        provider: "docker-compose",
        image,
        engine: known?.engine,
        ports: normaliseList(spec?.ports),
        dependsOn: normaliseList(spec?.depends_on),
        build: typeof spec?.build === "string" ? spec.build : spec?.build?.context,
      },
      provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
    });

    if (known) {
      kb.addStackItem({
        id: `stack:${known.engine}`,
        name: known.engine,
        version: image?.split(":")[1],
        category: known.category === "other" ? "other" : known.category,
        role: `Runs as the \`${name}\` container.`,
        provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
      });
      // Persisted models were pointed at a placeholder store; now that a real
      // engine is known, connect the placeholder to it.
      kb.addEdge({
        from: ids.datastore("primary-database"), to: nodeId, kind: "deploys",
        label: known.engine,
        provenance: {
          method: "heuristic", extractor: EXTRACTOR, confidence: 0.7, evidence: [ref],
          note: "Only relational service declared in the compose stack.",
        },
      });
    }

    for (const dep of normaliseList(spec?.depends_on)) {
      kb.addEdge({
        from: nodeId, to: ids.infra("compose", dep), kind: "dependsOn",
        provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
      });
      kb.addEdge({
        from: nodeId, to: ids.datastore(dep), kind: "dependsOn",
        provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
      });
    }

    for (const envKey of envKeysOf(spec?.environment)) {
      kb.addEdge({
        from: nodeId, to: ids.envVar(envKey), kind: "configures",
        provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
      });
    }
  }
}

function envKeysOf(env: unknown): string[] {
  if (Array.isArray(env)) {
    return env
      .map((e) => (typeof e === "string" ? e.split("=")[0] : undefined))
      .filter((k): k is string => Boolean(k));
  }
  if (env && typeof env === "object") return Object.keys(env as Record<string, unknown>);
  return [];
}

function normaliseList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>);
  if (typeof value === "string") return [value];
  return [];
}

/* ---------- Dockerfile ---------- */

function extractDockerfile(kb: KBBuilder, file: WalkedFile): void {
  const raw = readFileSafe(file.absPath);
  if (!raw) return;
  const lines = raw.split("\n");
  const stages: string[] = [];
  let baseImage: string | undefined;
  let exposed: string[] = [];

  lines.forEach((line, i) => {
    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line.trim());
    if (from?.[1]) {
      baseImage ??= from[1];
      if (from[2]) stages.push(from[2]);
    }
    const expose = /^EXPOSE\s+(.+)/i.exec(line.trim());
    if (expose?.[1]) exposed.push(...expose[1].trim().split(/\s+/));
    void i;
  });

  const ref: SourceRef = { file: file.path, startLine: 1 };
  kb.addNode({
    id: ids.infra("docker", file.path),
    kind: "infraResource",
    name: path.posix.basename(path.posix.dirname(file.path)) || "image",
    layer: "infra",
    location: ref,
    summary: stages.length > 1
      ? `Multi-stage image (${stages.length} stages) based on \`${baseImage}\`.`
      : `Container image based on \`${baseImage}\`.`,
    attrs: { provider: "docker", resourceType: "image", baseImage, stages, ports: exposed },
    provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
  });
}

/* ---------- Kubernetes ---------- */

const K8S_KINDS = new Set([
  "Deployment", "StatefulSet", "Service", "Ingress", "CronJob", "Job",
  "ConfigMap", "Secret", "DaemonSet", "PersistentVolumeClaim", "HorizontalPodAutoscaler",
]);

function extractKubernetes(kb: KBBuilder, file: WalkedFile): void {
  const raw = readFileSafe(file.absPath);
  if (!raw || !/^\s*apiVersion:/m.test(raw)) return;

  let docs: unknown[];
  try {
    docs = YAML.parseAllDocuments(raw).map((d) => d.toJS());
  } catch {
    return;
  }

  for (const doc of docs) {
    const manifest = doc as Record<string, any> | null;
    const kind = manifest?.kind;
    if (typeof kind !== "string" || !K8S_KINDS.has(kind)) continue;
    const name = manifest?.metadata?.name;
    if (typeof name !== "string") continue;

    const ref: SourceRef = { file: file.path, startLine: 1 };
    kb.addNode({
      id: ids.infra("k8s", `${kind}/${name}`),
      kind: "infraResource",
      name: `${kind}/${name}`,
      layer: "infra",
      location: ref,
      summary: `Kubernetes ${kind}.`,
      attrs: {
        provider: "kubernetes",
        resourceType: kind,
        replicas: manifest?.spec?.replicas,
        image: manifest?.spec?.template?.spec?.containers?.[0]?.image,
      },
      provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
    });

    kb.addStackItem({
      id: "stack:kubernetes",
      name: "Kubernetes",
      category: "container",
      role: "Schedules and supervises the running containers.",
      conceptIds: ["concept.declarative-infrastructure"],
      provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
    });
  }
}

/* ---------- utilities ---------- */

function findLine(lines: string[], re: RegExp): number | undefined {
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i] ?? "")) return i + 1;
  }
  return undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
