import path from "node:path";
import YAML from "yaml";
import { ids, KBBuilder } from "../kb/builder.js";
import type { SourceRef } from "../kb/types.js";
import { readFileSafe, type WalkedFile } from "../core/walk.js";

const EXTRACTOR = "github-actions@0.1.0";

/**
 * GitHub Actions workflows.
 *
 * A CI pipeline is one of the few parts of a system that is entirely invisible
 * from the application code, and it is usually the first thing a new engineer
 * needs and the last thing anyone documents. The job graph in particular is
 * load-bearing: "runs later" and "runs only if that passed" look identical in a
 * file read top to bottom, and only `needs:` distinguishes them.
 */
export function extractGitHubActions(kb: KBBuilder, files: WalkedFile[]): void {
  const workflows = files.filter((f) =>
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f.path),
  );
  if (workflows.length === 0) return;

  for (const file of workflows) {
    const raw = readFileSafe(file.absPath);
    if (!raw) continue;

    let doc: Record<string, any>;
    try {
      doc = YAML.parse(raw) as Record<string, any>;
    } catch {
      kb.addDiagnostic({
        level: "warn", extractor: EXTRACTOR,
        message: "Workflow could not be parsed as YAML.", file: file.path,
      });
      continue;
    }
    if (!doc || typeof doc !== "object") continue;

    const lines = raw.split("\n");
    const workflowId = ids.infra("github-actions", file.path);
    const name = typeof doc.name === "string" ? doc.name : path.posix.basename(file.path);
    const ref: SourceRef = { file: file.path, startLine: 1 };

    // `on` is the YAML 1.1 boolean `true` once parsed, which is a genuinely
    // surprising footgun and the reason this reads both spellings.
    const triggers = normaliseTriggers(doc.on ?? doc[true as unknown as string]);

    kb.addNode({
      id: workflowId,
      kind: "infraResource",
      name,
      layer: "build",
      location: ref,
      summary: triggers.length > 0
        ? `Workflow triggered by ${triggers.join(", ")}.`
        : "Workflow with no recognised trigger.",
      tags: triggers.includes("pull_request_target") ? ["elevated-trust-trigger"] : [],
      attrs: {
        provider: "github-actions",
        resourceType: "workflow",
        triggers,
        permissions: doc.permissions,
        concurrency: doc.concurrency?.group ?? doc.concurrency,
        cancelInProgress: doc.concurrency?.["cancel-in-progress"],
        jobCount: Object.keys(doc.jobs ?? {}).length,
      },
      provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [ref] },
    });

    const jobs = (doc.jobs ?? {}) as Record<string, any>;
    for (const [jobKey, job] of Object.entries(jobs)) {
      if (!job || typeof job !== "object") continue;
      const jobLine = findLine(lines, new RegExp(`^\\s{2}${escapeRe(jobKey)}\\s*:`)) ?? 1;
      const jobRef: SourceRef = { file: file.path, startLine: jobLine };
      const jobId = `job:${file.path}#${jobKey}`;
      const needs = toArray(job.needs);
      const steps = extractSteps(job.steps, file.path, lines);

      kb.addNode({
        id: jobId,
        kind: "job",
        name: typeof job.name === "string" ? job.name : jobKey,
        qualifiedName: `${name} / ${jobKey}`,
        layer: "build",
        location: jobRef,
        summary: describeJob(job, steps),
        tags: [
          ...(job.environment ? ["gated"] : []),
          ...(steps.some((s) => s.unpinned) ? ["unpinned-actions"] : []),
        ],
        attrs: {
          key: jobKey,
          runsOn: job["runs-on"],
          environment: typeof job.environment === "string" ? job.environment : job.environment?.name,
          permissions: job.permissions,
          needs,
          if: job.if,
          continueOnError: job["continue-on-error"],
          strategy: job.strategy ? { matrix: Boolean(job.strategy.matrix), failFast: job.strategy["fail-fast"] } : undefined,
          steps,
        },
        provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [jobRef] },
      });

      kb.addEdge({
        from: jobId, to: workflowId, kind: "definedIn",
        provenance: { method: "extracted", extractor: EXTRACTOR },
      });

      // The `needs` graph is the workflow's real structure. Without it, a
      // reader cannot tell a job that merely runs later from one that is gated.
      for (const need of needs) {
        kb.addEdge({
          from: jobId, to: `job:${file.path}#${need}`, kind: "dependsOn",
          label: `needs: ${need}`,
          provenance: {
            method: "extracted", extractor: EXTRACTOR, evidence: [jobRef],
            note: "Declared dependency: this job does not start until that one succeeds.",
          },
        });
      }

      for (const step of steps) {
        if (!step.uses) continue;
        const [actionName, actionVersion] = splitAction(step.uses);
        const depId = ids.dependency("github-action", actionName);
        kb.addNode({
          id: depId,
          kind: "dependency",
          name: actionName,
          layer: "build",
          attrs: { ecosystem: "github-action", version: actionVersion, dev: false, pinnedToSha: !step.unpinned },
          provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [jobRef] },
        });
        kb.addEdge({
          from: jobId, to: depId, kind: "dependsOn",
          label: step.uses,
          provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [jobRef] },
        });
      }

      for (const secret of secretsReferenced(job)) {
        kb.addNode({
          id: ids.envVar(secret),
          kind: "envVar",
          name: secret,
          layer: "config",
          location: jobRef,
          tags: ["ci-secret"],
          attrs: { key: secret, required: true, source: "github-secrets" },
          provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [jobRef] },
        });
        kb.addEdge({
          from: jobId, to: ids.envVar(secret), kind: "configures",
          provenance: { method: "extracted", extractor: EXTRACTOR, evidence: [jobRef] },
        });
      }
    }
  }

  kb.addStackItem({
    id: "stack:github-actions",
    name: "GitHub Actions",
    category: "ci",
    role: "Runs the build, test and release pipeline on repository events.",
    conceptIds: ["concept.continuous-integration"],
    provenance: {
      method: "extracted", extractor: EXTRACTOR,
      evidence: [{ file: workflows[0]!.path, startLine: 1 }],
    },
  });
}

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  /** True when the action is referenced by a movable tag rather than a commit. */
  unpinned?: boolean;
  startLine?: number;
}

function extractSteps(raw: unknown, file: string, lines: string[]): Step[] {
  if (!Array.isArray(raw)) return [];
  const out: Step[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const step = entry as Record<string, any>;
    const uses = typeof step.uses === "string" ? step.uses : undefined;
    const name = typeof step.name === "string" ? step.name : undefined;
    out.push({
      name,
      uses,
      run: typeof step.run === "string" ? firstLine(step.run) : undefined,
      if: typeof step.if === "string" ? step.if : undefined,
      // A 40-hex ref is a commit; anything else is a tag or branch the owner
      // can repoint, which is the supply-chain distinction that matters.
      unpinned: uses ? !/@[0-9a-f]{40}$/.test(uses) : undefined,
      startLine: name ? findLine(lines, new RegExp(`name:\\s*['"]?${escapeRe(name)}`)) : undefined,
    });
    void file;
  }
  return out;
}

function describeJob(job: Record<string, any>, steps: Step[]): string {
  const parts: string[] = [];
  parts.push(`${steps.length} step${steps.length === 1 ? "" : "s"}`);
  if (job["runs-on"]) parts.push(`on ${JSON.stringify(job["runs-on"]).replace(/"/g, "")}`);
  if (job.environment) parts.push("gated by an environment");
  if (job.strategy?.matrix) parts.push("runs as a matrix");
  return `${parts.join(", ")}.`;
}

function normaliseTriggers(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === "object") return Object.keys(on as Record<string, unknown>);
  return [];
}

function toArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.map(String);
  return [];
}

function splitAction(uses: string): [string, string | undefined] {
  const at = uses.lastIndexOf("@");
  if (at === -1) return [uses, undefined];
  return [uses.slice(0, at), uses.slice(at + 1)];
}

function secretsReferenced(job: unknown): string[] {
  const text = JSON.stringify(job ?? {});
  const out = new Set<string>();
  for (const m of text.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (m[1] && m[1] !== "GITHUB_TOKEN") out.add(m[1]);
  }
  return [...out];
}

function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim().slice(0, 160);
}

function findLine(lines: string[], re: RegExp): number | undefined {
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i] ?? "")) return i + 1;
  }
  return undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
