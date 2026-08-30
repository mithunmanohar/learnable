import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scan } from "../scan.js";
import type { KBNode, KnowledgeBase } from "../kb/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, "../../../..", "fixtures", "miniapp");

let cached: KnowledgeBase | undefined;
async function kb(): Promise<KnowledgeBase> {
  cached ??= await scan(fixtureRoot, { useGit: false });
  return cached;
}

const byName = (nodes: KBNode[], name: string): KBNode | undefined =>
  nodes.find((n) => n.name === name);

/* ---------- GitHub Actions ---------- */

test("workflow jobs are extracted with their dependency graph", async () => {
  const k = await kb();
  const jobs = k.nodes.filter((n) => n.kind === "job");
  assert.equal(jobs.length, 3, `expected 3 jobs, got ${jobs.map((j) => j.name).join(", ")}`);

  const deploy = jobs.find((j) => j.attrs?.key === "deploy");
  assert.ok(deploy, "deploy job missing");
  assert.deepEqual(deploy.attrs?.needs, ["test", "build"]);
  assert.equal(deploy.attrs?.environment, "production");

  // The needs graph is the workflow's real structure: without these edges a
  // reader cannot tell a gated job from one that merely runs later.
  const edges = k.edges.filter((e) => e.kind === "dependsOn" && e.from === deploy.id);
  const targets = edges.map((e) => e.to);
  assert.ok(targets.some((t) => t.endsWith("#test")), "deploy -> test edge missing");
  assert.ok(targets.some((t) => t.endsWith("#build")), "deploy -> build edge missing");
});

test("action pinning is distinguished from a moving tag", async () => {
  const k = await kb();
  const actions = k.nodes.filter(
    (n) => n.kind === "dependency" && n.attrs?.ecosystem === "github-action",
  );
  const checkout = byName(actions, "actions/checkout");
  assert.ok(checkout, "actions/checkout not found");

  const awsCreds = byName(actions, "aws-actions/configure-aws-credentials");
  assert.ok(awsCreds, "aws-actions/configure-aws-credentials not found");
  assert.equal(
    awsCreds.attrs?.pinnedToSha,
    false,
    "an action referenced by tag must not be reported as pinned",
  );
});

test("workflow secrets become part of the config surface", async () => {
  const k = await kb();
  const secret = k.nodes.find((n) => n.kind === "envVar" && n.name === "DEPLOY_ROLE_ARN");
  assert.ok(secret, "workflow secret not captured");
  assert.ok(secret.tags?.includes("ci-secret"));
});

/* ---------- Terraform ---------- */

test("terraform blocks survive interpolated strings and heredocs", async () => {
  const k = await kb();
  const tf = k.nodes.filter((n) => n.attrs?.iac === "terraform");

  // aws_db_subnet_group and the module both sit *after* a string containing a
  // quoted interpolation and a heredoc carrying JSON braces. A scanner that
  // mishandles either loses every block that follows.
  assert.ok(
    tf.some((n) => n.name === "aws_db_instance.primary"),
    "resource before the interpolated string is missing",
  );
  assert.ok(
    tf.some((n) => n.name === "aws_db_subnet_group.primary"),
    "resource after the interpolated string is missing — brace tracking desynchronised",
  );
  assert.ok(
    k.nodes.some((n) => n.kind === "module" && n.name === "module.network"),
    "module after the heredoc is missing",
  );
});

test("terraform state backend is reported as a security boundary", async () => {
  const k = await kb();
  const backend = k.nodes.find((n) => n.attrs?.resourceType === "backend");
  assert.ok(backend, "backend block not extracted");
  assert.equal(backend.attrs?.backend, "s3");
  assert.equal(backend.attrs?.locking, true, "use_lockfile should register as locking");
});

test("terraform variables record whether the caller must supply them", async () => {
  const k = await kb();
  const vars = k.nodes.filter((n) => n.attrs?.kind === "terraform-variable");
  const required = vars.find((v) => v.name === "environment");
  const optional = vars.find((v) => v.name === "instance_count");
  assert.ok(required && optional, "terraform variables not extracted");
  assert.equal(required.attrs?.required, true, "a variable with no default is required");
  assert.equal(optional.attrs?.required, false, "a variable with a default is not required");
});

test("lifecycle guards are surfaced", async () => {
  const k = await kb();
  const db = k.nodes.find((n) => n.name === "aws_db_instance.primary");
  assert.ok(db?.tags?.includes("prevent-destroy"), "prevent_destroy should be tagged");
});

test("terraform node ids are scoped by module directory", async () => {
  const k = await kb();
  // Addresses are only unique within a module, so the id must carry the
  // directory or same-named resources in different modules collide and dedupe.
  const db = k.nodes.find((n) => n.name === "aws_db_instance.primary");
  assert.ok(db, "resource missing");
  assert.ok(
    db.id.includes("infra/"),
    `node id must be module-scoped, got ${db.id}`,
  );
});
