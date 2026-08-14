# The Learnable Knowledge Base format

Two schemas, deliberately separate:

| File | Scope | Lifetime |
|---|---|---|
| `kb.schema.json` | One repository | Regenerated every scan, thrown away with the repo |
| `concept.schema.json` | Transferable engineering concepts | **Accumulates forever, across every repo you scan** |

That split is the whole idea. A knowledge base describes *this* system. The concept
catalog describes *engineering*. Keeping them in one document would tie what you
learned to a codebase that will be deleted in two years.

---

## 1. Provenance: the trust backbone

Every node, edge, trace step, binding and decision carries a `provenance` object.
It has four `method` values, and the viewer must render them differently:

| Method | Meaning | Trust |
|---|---|---|
| `extracted` | Read directly from an AST or a manifest | True of the source as parsed |
| `heuristic` | Matched a convention, naming pattern or framework idiom | Usually right, sometimes wrong |
| `inferred` | Produced by a language model | **A claim, not a fact** |
| `authored` | Written by a human | As good as the human |

The reason this exists: a generated architecture document that quietly mixes
"this function calls that one" (verifiable) with "this implements the repository
pattern to decouple persistence" (an opinion, possibly wrong) will teach you
things that are not true. Separating the two is not polish, it is the feature
that makes the output safe to learn from.

Every provenance carries `evidence: SourceRef[]` — a `file` plus `startLine`.
**A claim with no evidence is a bug**, and the linter treats it as one.

---

## 2. The graph

### Nodes

`id` is deterministic (`<kind>:<path>#<symbol>`), so two scans of the same repo
diff cleanly. That is what makes `git diff` on a committed KB a usable "what did
the agent change about my system" briefing.

| Kind | `attrs` payload |
|---|---|
| `service` | `{ root, language, framework }` |
| `module` / `file` | `{ path, language, loc }` |
| `symbol` | `{ symbolKind: function\|class\|method, params, returns, async, decorators }` |
| `route` | `{ method, path, fullPath, handlerId, requestModel, responseModel, auth }` |
| `uiComponent` | `{ isPage, routePath, hooks, props }` |
| `dataModel` | `{ persisted, table, fields[], baseModels[] }` |
| `datastore` | `{ engine, version }` |
| `infraResource` | `{ provider, resourceType, image, ports }` |
| `envVar` | `{ key, required, defaultValue, usedBy[] }` |
| `dependency` | `{ ecosystem, version, dev }` |

`layer` (ui → client → transport → api → domain → data → infra) is the vertical
axis of the trace view. It is what lets a diagram be laid out meaningfully
instead of as a force-directed hairball.

### Edges

Structural (`imports`, `calls`, `renders`, `handles`, `definedIn`), data
(`readsFrom`, `writesTo`, `transformsTo`, `validates`), cross-service
(`httpCall`, `emits`, `consumes`), operational (`deploys`, `configures`), and
historical (`changesWith`).

Two deserve comment:

- **`transformsTo`** links data models to each other (`UserBase → UserCreate`,
  `User → UserPublic`). Full-stack understanding is largely knowing where data
  changes shape and why, and this edge is that.
- **`changesWith`** comes from git history: files that are repeatedly committed
  together. It exposes real coupling that the import graph hides, and it is
  often the single most surprising view for someone who thinks they know a
  codebase.

---

## 3. Traces — the primary view

A `Trace` is one user-visible action followed all the way down and back:

```
ui-event → client-call → transport → route → validation → handler
         → query → store → serialize → response → render
```

Each `TraceStep` optionally carries a `dataShape` (`form-state`, `wire`, `dto`,
`domain`, `row`). **The data-lifecycle view is not a separate extraction** — it
is the sequence of `dataShape` values along a trace, which is why the two most
valuable views cost one implementation.

Traces are built by joining HTTP **call sites** in frontend code to route
**definitions** in backend code on `(method, path)`. That join is the only place
the extractor crosses a service boundary, and it is what turns per-service
knowledge into full-stack knowledge.

---

## 4. Concepts — why this is a framework and not a repo visualiser

A concept is stored as a *derivation*, never a definition:

```
problem    the constraint in the world that forces the issue
naive      what you would obviously try first
failure    the concrete scenario where that breaks
resolution the technique, as a response to that failure
cost       what you gave up to get it
```

`cost` is mandatory. A technique taught without its cost produces cargo-culting,
which is the failure mode of every generated architecture document.

`detect[]` rules bind concepts to real nodes at scan time. So "optimistic
concurrency" stops being a phrase you have read and becomes a thing with three
sightings across two of your repos, each with a line number.

`probes[]` carry the active-recall layer. `kind: "predict"` probes are asked
*before* the code is revealed — being wrong is the mechanism, not a failure.

---

## 5. Diagnostics

`diagnostics[]` records what the extractors could **not** work out. A KB that
silently omits the half of the system it failed to parse is worse than useless,
because you cannot tell absence-of-feature from absence-of-support. Coverage
gaps are part of the output.
