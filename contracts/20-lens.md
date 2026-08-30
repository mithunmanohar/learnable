---
id: lens
version: 0.1.0
produces: artifact.lenses[].sections
inherits: 00-conventions.md
---

# Contract: filling a lens

Run once per lens selected by `10-orientation`. If a domain contract exists for
this lens (`contracts/lenses/*.md`), apply it **in addition** to this one — it
adds domain specifics, it does not replace this structure.

## The mandatory section order

Every lens opens the same way, because the ordering *is* the pedagogy.

### Section 1 — `first-principles` (required, `depth: overview`)

Before describing anything in this repository, derive the central technology or
pattern of this lens:

- `problem` — the constraint in the world that forces it. No product names.
- `naive` — what a competent engineer would try first, stated sympathetically.
  It must sound reasonable, because it is.
- `failure` — the concrete scenario where that breaks. Concrete: a number, a
  scale, a specific event. Not "it does not scale".
- `resolution` — the technique, derived as a response to that failure.
- `cost` — mandatory. What was given up.
- `alternatives[]` — each with `whenBetter`.

**This section must be understandable by a reader who has never used the
technology.** It is the section that makes the whole framework different from
documentation, and it is the one to spend the most care on.

### Section 2 — `explanation`: how this system uses it (`depth: overview`)

*Now* describe this repository. Cite node ids and `file:line` throughout. Keep
it to the shape of the thing: what exists, how the pieces relate, what is
notable or unusual about the arrangement.

Flag anything that departs from the conventional use of the technology — a
departure is either a deliberate decision worth understanding or a mistake worth
noticing, and both are valuable.

### Section 3+ — domain-specific (2–5 sections)

Choose the kinds that fit the material:

| kind | Use for |
|---|---|
| `config-anatomy` | a file that *is* the subject — workflows, manifests, Terraform modules. Requires `annotatedSource`. |
| `walkthrough` | a sequence: what happens on push, how a request flows, what a deploy does |
| `topology` | spatial arrangement — networks, clusters, service graphs. Requires `diagram`. |
| `pattern` | a recurring structure in the code, named and explained |
| `trade-off` | a decision with live consequences |
| `failure-analysis` | what breaks when a component does |
| `comparison` | this approach against a named alternative, with `whenBetter` |

### Final section — `invariant` (required)

What must remain true in this area, and what currently enforces it. Populate
`artifact.invariants[]` as well.

Pay particular attention to invariants whose `enforcement` is `convention` or
`unenforced` — those are the ones a future change will silently break, and
naming them is among the most useful things this framework produces.

## Progressive disclosure

Generate **overview depth only**. For each section that has more beneath it, set:

```json
"expansion": {
  "contractId": "lens.<domain>@0.1.0#deep",
  "generated": false,
  "focus": "what the expansion should cover",
  "scopeFiles": ["path/to/relevant/file"]
}
```

Do not generate `working` or `deep` children in this pass. Cost should follow
what the reader actually opens.

## Diagrams

Use `diagram` where spatial or sequential relationships carry the meaning —
network topology, a job graph, a request path. Emit Mermaid in `diagram.mermaid`
and populate `diagram.nodeIds` so elements can link back to evidence.

Do not diagram what a sentence conveys. A three-box diagram is decoration.

## Budget

3–7 sections. 150–400 words each. The whole lens should be readable in under ten
minutes at overview depth.
