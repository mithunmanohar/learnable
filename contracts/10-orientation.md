---
id: orientation
version: 0.1.0
produces: artifact.orientation, artifact.lenses[].{id,name,domain,question,summary,order}
inherits: 00-conventions.md
---

# Contract: orientation and lens selection

The first pass. Establishes what the system is for, and decides which
cross-sections it should be viewed through. Everything downstream depends on
getting the lens set right, so this pass reads broadly and writes little.

## Inputs

`kb.json`, the repository tree, and all repository prose (`README`, `docs/`,
ADRs, `Makefile`, `compose.yml`, CI workflow names).

## Step 1 — Orientation

Produce `artifact.orientation`.

`problem` must be written **without naming a single component or technology**.
If you cannot say what the system does without saying "Kubernetes" or
"Postgres", you have described the implementation rather than the purpose, and
lesson 1 will fail for the reader.

Ask: *what would be worse in the world if this system did not exist?*

`notInScope` is worth real effort. What a system deliberately declines to do
often locates it faster than what it does — and an agent-built system frequently
has scope boundaries nobody wrote down. Derive them from what is conspicuously
absent (no payment handling, no multi-tenancy, no background jobs).

Where the README's description and the code disagree, follow the code and record
an `openQuestion`.

## Step 2 — Lens selection

Choose the cross-sections. **Lenses are viewpoints, not directories.** Do not
emit a lens per top-level folder.

Select from the `LensDomain` enum by evidence:

| Domain | Select when the repository contains |
|---|---|
| `ci-cd` | `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`, pipeline definitions |
| `iac` | `.tf`, CDK, Pulumi, CloudFormation, Helm charts |
| `runtime-platform` | Kubernetes manifests, ECS/Lambda definitions, an infra resource that *is* the runtime |
| `network` | VPC/subnet/security-group resources, ingress, load balancers, service mesh |
| `security` | IAM policies, auth code, secret management, RBAC |
| `data` | data models, migrations, datastores |
| `api` | HTTP routes, GraphQL schema, gRPC services |
| `frontend` | UI components, client routing, client state |
| `messaging` | queues, topics, event buses |
| `observability` | metrics, tracing, logging configuration, alerts |
| `testing` | meaningful test suites, fixtures, CI test stages |
| `cost` | only when cost-shaping configuration is explicit (instance sizing, autoscaling bounds, storage classes) |

Rules:

- **Three to seven lenses.** Fewer misses the system; more fragments it.
- A lens must be justified by evidence you can cite. No speculative lenses.
- Order them so that later lenses can assume earlier ones. Generally:
  purpose-bearing lenses (`api`, `data`) before delivery lenses (`ci-cd`,
  `iac`), and `runtime-platform` before `network` before `security`.
- Each lens's `question` is the question that cross-section exists to answer,
  phrased from the position of someone who does not yet know the answer.
  - Good: *"How does a packet from the internet reach a pod?"*
  - Bad: *"Networking configuration"*

## Step 3 — Concept requirements

For each lens, list `conceptIds` a reader needs. Reference existing ids from
`catalog/concepts.json` where they fit. Where a needed concept is absent from
the catalog, still name it with a `concept.`-prefixed id and record a
`diagnostic` at level `gap` — the catalog is expected to grow this way, and the
gap list is how it knows what to grow into.

## Output

Only `orientation` plus lens headers (`id`, `name`, `domain`, `question`,
`summary`, `order`, `conceptIds`). **Do not generate `sections`** — each lens is
filled by its own lens contract in the next pass.

Budget: orientation ≤ 250 words; each lens summary ≤ 80 words.
