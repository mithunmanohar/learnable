import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { scan } from "../scan.js";
import { loadCatalog } from "../concepts/bind.js";
import type { KnowledgeBase } from "../kb/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const specDir = path.join(repoRoot, "spec");
const fixtureRoot = path.join(repoRoot, "fixtures", "miniapp");

function validator(schemaFile: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(fs.readFileSync(path.join(specDir, schemaFile), "utf8"));
  return ajv.compile(schema);
}

let cachedKb: KnowledgeBase | undefined;
async function fixtureKb(): Promise<KnowledgeBase> {
  cachedKb ??= await scan(fixtureRoot, { useGit: false });
  return cachedKb;
}

/**
 * The JSON Schema is the portable contract. If the emitter can produce output
 * that violates it, the contract is a comment rather than a guarantee — so this
 * runs the real extractor over a real fixture and validates the real output.
 */
test("emitted knowledge base conforms to kb.schema.json", async () => {
  const kb = await fixtureKb();
  const validate = validator("kb.schema.json");
  const ok = validate(kb);
  assert.ok(
    ok,
    `KB failed schema validation:\n${(validate.errors ?? [])
      .slice(0, 20)
      .map((e) => `  ${e.instancePath || "/"} ${e.message}`)
      .join("\n")}`,
  );
});

test("shipped concept catalog conforms to concept.schema.json", () => {
  const catalog = loadCatalog(path.join(repoRoot, "catalog", "concepts.json"));
  const validate = validator("concept.schema.json");
  const ok = validate(catalog);
  assert.ok(
    ok,
    `Catalog failed schema validation:\n${(validate.errors ?? [])
      .slice(0, 20)
      .map((e) => `  ${e.instancePath || "/"} ${e.message}`)
      .join("\n")}`,
  );
  assert.ok(catalog.concepts.length > 0, "catalog is empty");
});

test("every concept prerequisite resolves to a real concept", () => {
  const catalog = loadCatalog(path.join(repoRoot, "catalog", "concepts.json"));
  const known = new Set(catalog.concepts.map((c) => c.id));
  for (const concept of catalog.concepts) {
    for (const id of [...(concept.prerequisites ?? []), ...(concept.seeAlso ?? [])]) {
      assert.ok(known.has(id), `${concept.id} references unknown concept ${id}`);
    }
  }
});

/**
 * Provenance without evidence is the failure this whole format exists to
 * prevent: an unattributable claim that reads exactly like a verified fact.
 */
test("extracted facts cite their evidence", async () => {
  const kb = await fixtureKb();
  const offenders = kb.nodes.filter(
    (n) =>
      n.provenance.method === "extracted" &&
      !n.location &&
      (n.provenance.evidence ?? []).length === 0 &&
      // Synthetic aggregates legitimately have no single source line.
      n.kind !== "datastore" && n.kind !== "dependency" && n.kind !== "service",
  );
  assert.equal(
    offenders.length,
    0,
    `nodes claiming 'extracted' with no citation: ${offenders.map((n) => n.id).join(", ")}`,
  );
});

test("no edge points at a node that does not exist", async () => {
  const kb = await fixtureKb();
  const ids = new Set(kb.nodes.map((n) => n.id));
  const dangling = kb.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
  assert.equal(dangling.length, 0, `dangling edges: ${dangling.map((e) => e.id).join(", ")}`);
});

test("node ids are unique", async () => {
  const kb = await fixtureKb();
  const seen = new Set<string>();
  for (const n of kb.nodes) {
    assert.ok(!seen.has(n.id), `duplicate node id: ${n.id}`);
    seen.add(n.id);
  }
});

/**
 * Determinism is what makes a committed KB diffable, which is what makes the
 * "what did the agent change" briefing possible. Everything except the
 * timestamp must be byte-identical between runs.
 */
test("two scans of an unchanged repo produce identical output", async () => {
  const a = await scan(fixtureRoot, { useGit: false });
  const b = await scan(fixtureRoot, { useGit: false });
  const strip = (kb: KnowledgeBase): string =>
    JSON.stringify({ ...kb, generatedAt: "" });
  assert.equal(strip(a), strip(b));
});

test("the fixture's full stack resolves into an end-to-end trace", async () => {
  const kb = await fixtureKb();

  const route = kb.nodes.find((n) => n.kind === "route" && n.attrs?.path === "/api/v1/notes/");
  assert.ok(route, "route path was not composed through the include_router chain");

  // Target the create trace specifically: it is the one that exercises every
  // stage, including validation on the way in and a write to the table.
  const trace = (kb.traces ?? []).find((t) => t.id === "trace:POST /api/v1/notes/");
  assert.ok(trace, "no trace joined the client call site to the server route");

  const roles = trace.steps.map((s) => s.role);
  for (const required of ["ui-event", "client-call", "route", "validation", "handler", "store", "serialize", "render"]) {
    assert.ok(roles.includes(required as never), `trace is missing a '${required}' step`);
  }

  // The lifecycle view is the sequence of shapes along the trace, so a trace
  // that never changes shape would render as a flat line.
  const shapes = trace.steps.flatMap((s) => (s.dataShape ? [s.dataShape.kind] : []));
  assert.ok(new Set(shapes).size >= 3, `expected several distinct data shapes, saw ${shapes.join(", ")}`);
});

test("scanning a directory with no manifest degrades gracefully", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "learnable-empty-"));
  try {
    fs.writeFileSync(path.join(empty, "notes.txt"), "nothing to see");
    const kb = await scan(empty, { useGit: false });
    const validate = validator("kb.schema.json");
    assert.ok(validate(kb), "empty-repo KB must still be schema-valid");
    assert.ok(
      (kb.diagnostics ?? []).some((d) => d.level === "gap"),
      "a repo with nothing to extract should say so in diagnostics",
    );
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
