# Learnable

Turns a repository into a **first-principles learning engine** — not
documentation of it.

That distinction is the whole point. Documentation frameworks describe a system
to a reader assumed to already understand its parts: they tell you the service
runs on EKS and take for granted that you know what a managed control plane is,
why you would want one, and what it costs. That assumption fails precisely when
an agent wrote the system and chose components you have never operated.

Learnable inverts it. Every component is explained from the problem that forces
it to exist, and **implementation is the last thing you are shown.**

> **Status.** The format and the extractor are complete and verified against a
> real third-party repository. The analysis contracts are written. The viewer is
> next — see [Roadmap](#roadmap).

---

## The four layers

| Layer | Question | Content | Produced by |
|---|---|---|---|
| **1. Structural** | What exists? | services, modules, datastores, queues, APIs, dependencies, infra | Deterministic extractor |
| **2. Behavioral** | What happens? | request paths, event flows, failure paths | Extractor traces + analyst |
| **3. Design** | Why built this way? | constraints, trade-offs, patterns, invariants, consistency, scaling, security boundaries | Analyst |
| **4. Learning model** | How should a human learn this? | an ordered curriculum with prerequisites, predictions, drill-downs | Analyst |

Layers 1–2 are *facts about the system*. **Layers 3–4 are the product.** A tool
that stops at Layer 2 is a code-intelligence tool, and there are many.

## Two engines, and why both

Layers 3 and 4 cannot be extracted — no syntax tree contains the reason EKS was
chosen over ECS, or which invariant must never be violated. That needs a
language model. But a model turned loose on a repository produces fluent,
confident, partly-false architecture, which is the *worst* possible output: the
reader cannot tell which half is wrong and is learning from all of it.

```
 repo ──► EXTRACTOR ──► kb.json        Layers 1–2. Deterministic, verifiable.
          (AST, manifests,             Every node carries file:line.
           IaC, git history)
                             │  evidence to cite
                             ▼
 repo ──► ANALYST ──────► artifact.json    Layers 3–4. Contract-driven.
 + docs   (LLM, driven by                  Must cite the KB or the source.
           contracts/)
                             │
                             ▼
                          VIEWER
```

The extractor's most important job is not producing a graph. **It is being the
thing the analyst is required to cite:**

> A claim that cannot be anchored to a KB node id or a `file:line` is not
> stated. It becomes an **open question**.

This is enforced mechanically, not by good intentions — the test suite rejects
an artifact citing a node that does not exist or a line past the end of a file.

---

## Lenses: cross-sections, not folders

A repository is not understood in directory order. For a repo deploying an EKS
cluster with Terraform via GitHub Actions, the lenses are **not** `.github/`,
`terraform/`, `k8s/`. They are:

| Lens | The question it answers |
|---|---|
| `ci-cd` | What happens when I push, and what does each workflow step accomplish? |
| `iac` | How is infrastructure described, and which Terraform patterns are in use? |
| `runtime-platform` | What is the cluster, and what does a managed control plane give and cost? |
| `network` | How does a packet from the internet reach a pod? |
| `security` | What can assume which identity, and where are the trust boundaries? |

`runtime-platform` explains **EKS from first principles** — the problem a managed
control plane solves, what you would do without it, where that breaks, what you
pay — *before* saying anything about how this repository configures it.

### Progressive disclosure is structural

"Explore further on demand" is a schema requirement, not a UI nicety. Sections
carry a `depth` and either generated children or a **stub naming the contract
that would generate them**. Opening a stub triggers generation, so cost tracks
what is actually read, and the top level stays short enough to be read at all.

**Annotated source** is a first-class content type: a file plus line-range
explanations. It is how config-heavy domains are taught, because the file *is*
the subject.

---

## The lesson spine

| # | Intent | Question |
|---|---|---|
| 1 | `purpose` | What problem does this system solve, and for whom? |
| 2 | `structure` | What are the major subsystems? |
| 3 | `boundaries` | Why are they separated *there*? |
| 4 | `behavior` | How does one request flow through? |
| 5 | `failure` | What happens when X fails? |
| 6 | `technology-choice` | Why Y rather than the obvious alternative? |
| 7 | `invariants` | What must never be violated? |
| 8 | `implementation` | Now inspect the code. |

Two properties are load-bearing:

**Implementation is last.** Starting at the code means every design decision
arrives as an unexplained fact, leaving a reader able to *navigate* a system
without *understanding* it — exactly the position an experienced engineer is in
when an agent writes their codebase.

**Each lesson is a question.** "Authentication" is a topic to skim; "Can this
system log out a stolen session?" is a question to answer. Each is asked
**before** the code is revealed — the reader commits, then sees the evidence.
Being wrong is the mechanism.

---

## What the extractor produces

Scanning [`fastapi/full-stack-fastapi-template`](https://github.com/fastapi/full-stack-fastapi-template)
(246 files, Python + TypeScript):

```
nodes 978  edges 1057  traces 23  stack 35  concept bindings 13
```

### The trace view

```
User creates an item (from AddItem)

 0. ui / ui-event      `AddItem` needs this data              [form-state]
 1. client-call        `createItem` issues POST /api/v1/items/ [dto]
 2. transport          crosses the network                     [wire]
 3. api / middleware   Caller resolved from the bearer token
 4. api / route        Router dispatches to the handler
 5. api / validation   Body is parsed into `ItemCreate`        [dto]
 6. domain / handler   `create_item` runs
 7. data / store       Writes `Item` to table `item`           [row]
 8. data / query       Reads `Item` from table `item`          [row]
 9. api / serialize    Result reshaped into `ItemPublic`       [dto]
10. transport          Response travels back                    [wire]
11. ui / render        `AddItem` re-renders                    [form-state]
```

The bracketed shapes, read in sequence, are the **data-lifecycle view** — it
falls out of the same structure, so the two most valuable views cost one
implementation.

### The cross-stack join

Traces are the only place the KB crosses a process boundary, on the one thing
both sides agree on: **method + path**. That path is written down nowhere:

```python
# core/config.py      API_V1_STR: str = "/api/v1"
# main.py             app.include_router(api_router, prefix=settings.API_V1_STR)
# api/main.py         api_router.include_router(items.router)
# api/routes/items.py router = APIRouter(prefix="/items")
#                     @router.get("/")
```

The extractor resolves the settings constant, walks the `include_router` mount
tree to the application object, composes `GET /api/v1/items/`, then matches it
against `url: '/api/v1/items/'` in the generated frontend client.

---

## Usage

```bash
cd packages/extractor && npm install && npm run build
node dist/cli.js scan /path/to/repo      # writes <repo>/.learnable/kb.json
```

Commit `.learnable/kb.json` alongside the code. Node ids are deterministic and
output is sorted, so the diff between two scans is a readable account of how the
system changed.

## Layout

```
spec/       framework.md — the four layers and the two-engine architecture
            kb.schema.json        Layers 1–2, the evidence substrate
            artifact.schema.json  Layers 3–4, what the viewer renders
            concept.schema.json   first-principles units, patterns and technologies
contracts/  the LLM instruction set — conventions, orientation, lens, curriculum
            lenses/  domain contracts: GitHub Actions, Terraform, EKS
catalog/    concepts.json — 20 transferable concepts, repo-independent
fixtures/   miniapp + a worked example artifact
packages/extractor/
```

**Adding a domain is writing one contract file. No code changes.**

Language support is tree-sitter compiled to WebAssembly — no native toolchain,
identical everywhere. Today: Python (FastAPI, SQLModel, pydantic-settings),
TypeScript/JavaScript (React, TanStack, Express, Prisma), IaC (compose,
Dockerfile, Terraform, Kubernetes).

---

## Verification

Audited against the FastAPI template rather than eyeballed:

| Check | Result |
|---|---|
| HTTP routes found | **23 / 23**, exact line numbers, 0 missed, 0 spurious |
| Full paths resolved through the mount chain | 23 / 23 |
| Route → handler pairing | 23 / 23 correct |
| Client call site → route joins | 23 / 23 exact method+path identity |
| Persisted tables, required env vars | exact match |

`npm test` — **16 tests** — enforces the properties the framework depends on:

- emitted output validates against both schemas
- **every cited node id exists**; every `file:line` resolves
- every referenced concept exists in the catalog
- **every first-principles derivation states a cost** (an empty cost is a defect,
  not a style lapse — it is what produces cargo-culting)
- every lesson asks before it reveals, and names the plausible wrong answer
- the curriculum keeps implementation last
- two scans of an unchanged repo are byte-identical

Coverage gaps go in the KB's own `diagnostics[]` and the artifact's
`openQuestions[]`. An artifact with no open questions is not thorough; it is
overconfident.

---

## Roadmap

- **Format + extractor (Layers 1–2).** ✅ Complete and verified.
- **Analysis contracts (Layers 3–4).** ✅ Written, with a worked example artifact.
- **Next — the viewer.** Static SPA over `kb.json` + `artifact.json`: lens board,
  lesson spine with predict-then-reveal, trace player, lifecycle ribbon,
  annotated-source panel, first-principles cards, drill-down expansion.
- **Then — the analyst runner.** Executes the contracts against a repo and emits
  `artifact.json`, including on-demand expansion of stubs.
- **Then — delta briefings.** Diff two KBs across an agent's PR: what changed,
  which concepts newly entered your graph, which parts of your mental model are
  now stale.

### Known limitations

- TypeScript call resolution is name-based, not type-aware; ambiguous names are
  marked `heuristic` with lowered confidence.
- Terraform's value language is not evaluated — interpolated values are
  deliberately not reported rather than reported wrongly.
- Traces reflect the framework's request pipeline, not a recorded execution.
- Concept and lens explanations are authored or inferred; only the *sightings*
  are extracted. The provenance badge always says which.
