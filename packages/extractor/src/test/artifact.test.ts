import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { scan } from "../scan.js";
import type { KnowledgeBase } from "../kb/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const fixtureRoot = path.join(repoRoot, "fixtures", "miniapp");

const artifact = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "fixtures", "miniapp.artifact.json"), "utf8"),
);

function validator(schemaFile: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(JSON.parse(fs.readFileSync(path.join(repoRoot, "spec", schemaFile), "utf8")));
}

test("the worked example conforms to artifact.schema.json", () => {
  const validate = validator("artifact.schema.json");
  const ok = validate(artifact);
  assert.ok(
    ok,
    `artifact failed schema validation:\n${(validate.errors ?? [])
      .slice(0, 20)
      .map((e) => `  ${e.instancePath || "/"} ${e.message}`)
      .join("\n")}`,
  );
});

/**
 * The citation rule is the framework's load-bearing constraint, so it is
 * enforced mechanically rather than trusted. An artifact whose evidence points
 * at nodes that do not exist is exactly the confident-but-wrong output the
 * whole design is meant to prevent.
 */
test("every cited node id exists in the knowledge base", async () => {
  const kb: KnowledgeBase = await scan(fixtureRoot, { useGit: false });
  const known = new Set(kb.nodes.map((n) => n.id));
  const knownTraces = new Set((kb.traces ?? []).map((t) => t.id));

  const badNodes: string[] = [];
  const badTraces: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(obj)) {
      if (key === "nodeIds" && Array.isArray(child)) {
        for (const id of child) if (typeof id === "string" && !known.has(id)) badNodes.push(id);
      }
      if (key === "componentNodeId" && typeof child === "string" && !known.has(child)) {
        badNodes.push(child);
      }
      if (key === "traceIds" && Array.isArray(child)) {
        for (const id of child) if (typeof id === "string" && !knownTraces.has(id)) badTraces.push(id);
      }
      walk(child);
    }
  };
  walk(artifact);

  assert.deepEqual(badNodes, [], `cited node ids absent from the KB: ${badNodes.join(", ")}`);
  assert.deepEqual(badTraces, [], `cited trace ids absent from the KB: ${badTraces.join(", ")}`);
});

test("every cited source location points at a real file and line", () => {
  const problems: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (typeof obj.file === "string" && typeof obj.startLine === "number") {
      const abs = path.join(fixtureRoot, obj.file);
      if (!fs.existsSync(abs)) {
        problems.push(`missing file ${obj.file}`);
      } else {
        const lines = fs.readFileSync(abs, "utf8").split("\n").length;
        if (obj.startLine > lines) {
          problems.push(`${obj.file}:${obj.startLine} beyond end of file (${lines} lines)`);
        }
      }
    }
    for (const child of Object.values(obj)) walk(child);
  };
  walk(artifact);
  assert.deepEqual(problems, [], `unresolvable citations:\n  ${problems.join("\n  ")}`);
});

test("every referenced concept exists in the catalog", () => {
  const catalog = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "catalog", "concepts.json"), "utf8"),
  ) as { concepts: { id: string }[] };
  const known = new Set(catalog.concepts.map((c) => c.id));

  const missing: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(obj)) {
      if ((key === "conceptIds" || key === "prerequisiteConceptIds") && Array.isArray(child)) {
        for (const id of child) if (typeof id === "string" && !known.has(id)) missing.push(id);
      }
      if (key === "conceptId" && typeof child === "string" && !known.has(child)) missing.push(child);
      walk(child);
    }
  };
  walk(artifact);
  assert.deepEqual([...new Set(missing)], [], `concepts referenced but not in the catalog`);
});

/**
 * Cost is what separates teaching a trade-off from advertising a technique, so
 * an empty one is treated as a defect rather than a stylistic lapse.
 */
test("every first-principles derivation states a cost", () => {
  const offenders: string[] = [];
  const walk = (value: unknown, trail: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${trail}[${i}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (obj.firstPrinciples && typeof obj.firstPrinciples === "object") {
      const fp = obj.firstPrinciples as Record<string, unknown>;
      if (typeof fp.cost !== "string" || fp.cost.trim().length < 20) {
        offenders.push(`${trail} (${String(obj.id ?? "?")})`);
      }
    }
    for (const [key, child] of Object.entries(obj)) walk(child, `${trail}.${key}`);
  };
  walk(artifact, "artifact");
  assert.deepEqual(offenders, [], `first-principles blocks with a missing or trivial cost`);
});

test("every lesson asks before it reveals", () => {
  const lessons = (artifact.curriculum?.lessons ?? []) as Record<string, unknown>[];
  assert.ok(lessons.length > 0, "curriculum has no lessons");
  for (const lesson of lessons) {
    const probe = lesson.predictProbe as Record<string, unknown> | undefined;
    assert.ok(probe, `lesson ${lesson.id} has no predictProbe`);
    assert.equal(probe.kind, "predict", `lesson ${lesson.id} probe must be of kind 'predict'`);
    // The plausible mistake is usually the most instructive text in a lesson,
    // so its absence is a real omission rather than a missing nicety.
    assert.ok(
      typeof probe.commonWrongAnswer === "string" && probe.commonWrongAnswer.length > 0,
      `lesson ${lesson.id} does not name the plausible wrong answer`,
    );
    assert.ok(
      typeof lesson.question === "string" && (lesson.question as string).trim().endsWith("?"),
      `lesson ${lesson.id} is titled as a topic rather than a question`,
    );
  }
});

test("the curriculum keeps implementation last", () => {
  const lessons = (artifact.curriculum?.lessons ?? []) as { order: number; intent: string }[];
  const impl = lessons.find((l) => l.intent === "implementation");
  if (!impl) return; // partial curricula are allowed
  const maxOrder = Math.max(...lessons.map((l) => l.order));
  assert.equal(impl.order, maxOrder, "the implementation lesson must come last in the spine");
});
