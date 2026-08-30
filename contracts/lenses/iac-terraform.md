---
id: lens.terraform
version: 0.1.0
domain: iac
inherits: 00-conventions.md, 20-lens.md
---

# Domain contract: Terraform

Applies when `*.tf` files are present.

## First-principles section: what IaC is for

- **problem** — cloud resources get created by people clicking consoles. Nothing
  records what was done, and no two environments end up alike.
- **naive** — write a runbook describing the clicks.
- **failure** — runbooks go stale the first time someone deviates under
  pressure and does not update the document. Nothing detects the drift, so
  staging and production diverge invisibly until something behaves differently
  in one and not the other. Rebuilding after an outage means following prose
  while the site is down.
- **resolution** — declare the desired resources in version-controlled files.
  The tool diffs desired against actual and produces a plan, so infrastructure
  changes are reviewed like code and replayed identically.
- **cost** — the state file becomes critical and contended. Changes made outside
  the tool become drift it wants to revert. The abstraction leaks: you must
  understand the cloud primitive *and* the tool's model of it. And a plan
  applied without being read is a fast way to delete a database.

## The state model — always explain this

State is the concept that makes Terraform make sense and the one most often
skipped. Cover, at overview depth:

- State maps declared resources to real cloud object ids. Without it Terraform
  cannot tell "create a new one" from "this already exists".
- Where **this repository's** state lives — S3, Terraform Cloud, local. Cite it.
  Local state in a repo that deploys shared infrastructure is a finding.
- Locking (DynamoDB table, backend-native). Without a lock, two concurrent
  applies corrupt state.
- State contains resource attributes **including secrets in plaintext**, so the
  backend's access control is a real security boundary.

## What to extract

| | |
|---|---|
| **Backend** | type, bucket/workspace, locking mechanism, encryption |
| **Providers** | which, and how versions are constrained |
| **Module structure** | local modules vs registry modules, composition depth |
| **Environment strategy** | workspaces, directory-per-environment, or `.tfvars` |
| **Variables** | required vs defaulted, and which have no sensible default |
| **Outputs** | what this configuration publishes to other configurations |
| **Data sources** | what it reads that it does not own |
| **Remote state references** | coupling to other configurations |

## Patterns to name where present

Emit a `pattern` section for each you can cite:

- **Module composition** — a root module wiring reusable child modules. Explain
  the interface (variables in, outputs out) and why the boundary was drawn there.
- **Directory-per-environment vs workspaces** — explain the trade-off: directories
  duplicate code but make divergence explicit and reviewable; workspaces share
  code but make it easy to apply to the wrong one.
- **Registry modules** (e.g. `terraform-aws-modules/*`) — a large amount of
  behaviour arrives from one `module` block. Say what it creates, because the
  reader cannot see it in this repository, and note the version pin.
- **`for_each` over `count`** — `count` is index-addressed, so removing a middle
  element re-indexes and destroys/recreates everything after it. `for_each` is
  key-addressed and does not. This is a genuinely common production incident and
  worth explaining wherever `count` appears over a list.
- **Provider aliases** for multi-region or multi-account.
- **`lifecycle` blocks** — `prevent_destroy`, `ignore_changes`. Each is a
  statement about something that went wrong once; explain what.

## Required `config-anatomy` section

Annotate the root module (or the resource file that defines the primary
infrastructure). Focus on:

- resource dependencies, especially **implicit** ones created by referencing
  another resource's attribute — this is how Terraform builds its graph, and it
  is invisible to a reader who does not know to look for it
- `depends_on` where an implicit dependency was insufficient, and why
- anything with `prevent_destroy` or `ignore_changes`
- hardcoded values that look like they should be variables

## Invariants to look for

- State is remote and locked (`enforcement: convention` unless CI enforces it).
- Stateful resources carry `prevent_destroy`.
- No secret values in `.tf` or `.tfvars` committed to the repository — check,
  and report honestly.
- Provider and module versions are constrained rather than floating.
