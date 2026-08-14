# Learnable

A framework for understanding software systems you did not write — built for the
case where agents do the building and you still intend to be the engineer.

It scans a repository and produces a **knowledge base**: a portable, diffable
JSON document describing the tech stack, the architecture, the cross-stack
request paths, the decisions embedded in the code, and the transferable
engineering concepts each of those is an instance of.

> **Status.** Milestone 1 of 3 is complete: the format is specified and the
> extractor works end to end, validated against a real third-party repository.
> The viewer is not built yet — see [Roadmap](#roadmap).

---

## Why not just generate a wiki

The obvious version of this — point an agent at a repo, have it write
documentation — fails in three specific ways, and every design decision here is
a response to one of them.

**1. Description is not understanding.** A well-organised document about your
codebase produces familiarity, which feels like knowledge and is not. Learnable
therefore extracts *traces* and *concepts* rather than prose, and the concept
catalog stores derivations with active-recall probes instead of definitions.

**2. It is stale on the next commit.** A snapshot competing against an agent
that ships daily loses. So the knowledge base is deterministic, byte-stable,
and meant to be committed: `git diff` on it *is* the "what did the agent change
about my system" briefing.

**3. It teaches trivia, not principles.** "AuthService calls TokenRepository"
makes you better at this repo. So the framework keeps **two graphs** — the repo
graph, which is disposable, and the concept graph, which accumulates across
every repository you ever scan. That second graph is the actual deliverable.

And one failure mode that would make the whole thing worse than useless:
**confident, plausible, wrong architecture claims.** Every fact carries
provenance — `extracted` (from an AST or manifest), `heuristic` (a convention
match), `inferred` (a model's claim) — with `file:line` evidence. A reader can
always jump from a claim to the bytes that justify it.

---

## What it produces

Scanning [`fastapi/full-stack-fastapi-template`](https://github.com/fastapi/full-stack-fastapi-template)
(246 files, Python + TypeScript):

```
nodes    978  — 276 symbol, 248 dataModel, 174 uiComponent, 146 file,
                 74 dependency, 24 envVar, 23 route, 7 infraResource,
                 4 service, 2 datastore
edges    1057
traces   23
stack    35 items
concepts 13 bindings
```

### The trace view — one user action, followed all the way down

The single highest-value artifact, and the reason the extractor crosses service
boundaries at all:

```
User creates an item (from AddItem)

 0. ui / ui-event      `AddItem` needs this data              [form-state]
 1. client-call        `createItem` issues POST /api/v1/items/ [dto]
 2. transport          POST /api/v1/items/ crosses the network [wire]
 3. api / middleware   Caller is resolved from the bearer token
 4. api / route        Router dispatches to the handler
 5. api / validation   Body is parsed into `ItemCreate`        [dto]
 6. domain / handler   `create_item` runs
 7. data / store       Writes `Item` to table `item`           [row]
 8. data / query       Reads `Item` from table `item`          [row]
 9. api / serialize    Result is reshaped into `ItemPublic`    [dto]
10. transport          Response travels back to the browser    [wire]
11. ui / render        `AddItem` re-renders with the data      [form-state]
```

Every step carries a `file:line` citation and a provenance badge.

**The data-lifecycle view comes free.** The bracketed shapes above, read in
sequence, are the journey of one piece of data through every representation it
takes. Where `kind` changes is where the engineering decisions live — so the two
most valuable views cost one implementation.

### How the cross-stack join works

Every other extractor works inside a single service. Traces are the one place
the knowledge base crosses a process boundary, and it does so on the only thing
both sides genuinely agree on: **HTTP method + path**.

Getting there is the hard part. The route below is not written down anywhere:

```python
# app/core/config.py     API_V1_STR: str = "/api/v1"
# app/main.py            app.include_router(api_router, prefix=settings.API_V1_STR)
# app/api/main.py        api_router.include_router(items.router)
# app/api/routes/items.py  router = APIRouter(prefix="/items")
#                          @router.get("/")
```

The extractor resolves the settings constant, walks the `include_router` mount
tree to the application object, and composes `GET /api/v1/items/`. Only then can
it be matched against `url: '/api/v1/items/'` in the generated frontend client.

### Decisions

Reconstructed ADRs stating what was chosen, what was not, and **what it cost** —
always as observations, never endorsements:

> **Authentication is stateless, carried in a signed token**
> - No session lookup, so any instance can serve any request — this is what makes horizontal scaling straightforward.
> - Revocation is the price: a token stays valid until it expires, because nothing is consulted that could mark it dead.
> - The token is readable by anyone holding it — signing proves integrity, not confidentiality.

### Concepts — the part that outlives the repo

Concepts are stored as **derivations**, never definitions:

| field | |
|---|---|
| `problem` | the constraint in the world that forces the issue |
| `naive` | what you would obviously try first |
| `failure` | the concrete scenario where that breaks |
| `resolution` | the technique, as a response to that failure |
| `cost` | **what you gave up** — mandatory, because a technique taught without its cost produces cargo-culting |

Detection rules bind them to real code, so "optimistic concurrency" stops being
a phrase you have read and becomes a thing with sightings and line numbers in
your own systems. Probes make it active rather than passive:

> **predict** — *A user's laptop is stolen twenty minutes into a session. Before
> you look at the code: can this system log that session out immediately?*

`predict` probes are asked *before* the code is revealed. Being wrong is the
mechanism, not a failure.

---

## Usage

```bash
cd packages/extractor && npm install && npm run build

node dist/cli.js scan /path/to/repo          # writes <repo>/.learnable/kb.json
node dist/cli.js scan /path/to/repo -o kb.json --no-git
```

Commit `.learnable/kb.json` alongside the code. Because node ids are
deterministic and output is sorted, the diff between two scans is a readable
account of how the system changed.

---

## Layout

```
spec/       kb.schema.json, concept.schema.json — the portable contract
catalog/    concepts.json — 20 transferable concepts, repo-independent
fixtures/   miniapp — a small full stack exercising the hard extraction paths
packages/extractor/
  core/         tree-sitter WASM parsing, file walk, git co-change
  extractors/   manifests, python, typescript, infra
  synth/        traces, decisions
  concepts/     catalog loading and binding
```

Language support is via **tree-sitter compiled to WebAssembly** — no native
toolchain, identical behaviour everywhere, and adding a language is a grammar
file rather than a rebuild. Today: Python (FastAPI, SQLModel/SQLAlchemy,
pydantic-settings), TypeScript/JavaScript (React, TanStack Router/Query,
Express/Fastify, Prisma), and IaC (compose, Dockerfile, Terraform, Kubernetes).

---

## Verification

The extractor was audited against the FastAPI template rather than eyeballed:

| Check | Result |
|---|---|
| HTTP routes found | **23 / 23**, exact line numbers, 0 missed, 0 spurious |
| Full paths resolved through the mount chain | 23 / 23 |
| Route → handler pairing | 23 / 23 correct |
| Client call site → route joins | 23 / 23 exact method+path identity |
| Persisted tables (`table=True`) | exact match |
| Required env vars (no-default settings fields) | exact match |
| Superuser/user auth inference | correct on all spot-checks |

`npm test` (9 tests) additionally enforces the properties the format depends on:
emitted output validates against the JSON Schema, every `extracted` claim cites
evidence, no edge dangles, ids are unique, and **two scans of an unchanged repo
are byte-identical** — without which the change-briefing idea collapses.

Coverage gaps are recorded in the KB's own `diagnostics[]` rather than being
silently omitted, because a knowledge base that hides what it failed to parse
cannot be told apart from one describing a system that genuinely lacks the
feature.

---

## Roadmap

- **Milestone 1 — format + extractor.** ✅ Complete.
- **Milestone 2 — the viewer.** Static SPA over `kb.json`: the trace player, the
  data-lifecycle ribbon, a zoomable layered system map, and the concept graph
  with mastery state. No server; reads the committed JSON.
- **Milestone 3 — delta briefings.** Diff two knowledge bases across an agent's
  PR and render what changed, which concepts newly entered your graph, and which
  parts of your mental model are now stale. This is what makes the framework a
  daily habit rather than a one-time read.

### Known limitations

- Call resolution within TypeScript is name-based, not a full type-aware
  resolver; ambiguous names are marked `heuristic` with lowered confidence.
- Terraform's value language is not evaluated — resources are extracted, but
  interpolated attribute values are deliberately not reported rather than
  reported wrongly.
- Traces reflect the framework's request pipeline, not a recorded execution.
  They are labelled `heuristic` for that reason.
- Concept explanations are authored content; only the *sightings* are extracted.
