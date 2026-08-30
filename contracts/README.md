# Analysis contracts

The instruction set an LLM follows to turn a repository into a learning
artifact. These files *are* the framework's conventions — the extractor produces
evidence, the contracts decide what is made of it.

## Pipeline

```
                 ┌─────────────────────────────────────────┐
  repository ───►│ EXTRACTOR                    → kb.json   │  Layers 1–2
                 └─────────────────────────────────────────┘
                                   │ evidence to cite
                                   ▼
  ┌──────────────────────────────────────────────────────────┐
  │ 10-orientation   what is this for? which lenses?          │
  │       ▼                                                   │
  │ 20-lens (+ domain contract)   once per lens               │  Layer 3
  │       ▼                                                   │
  │ 30-curriculum    the ordered path through it              │  Layer 4
  └──────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                            artifact.json  ──► viewer
```

Each stage sees the previous stage's output. Passes are separate so a lens can
be regenerated, or a deeper section expanded, without redoing everything.

## Files

| File | Role |
|---|---|
| `00-conventions.md` | Inherited by all. Citation rule, provenance honesty, mandatory costs, no endorsement. |
| `10-orientation.md` | Pass 1. Purpose, and which lenses this repository needs. |
| `20-lens.md` | Pass 2, once per lens. Mandatory section ordering. |
| `30-curriculum.md` | Pass 3. The eight-lesson spine, predict-before-reveal. |
| `lenses/*.md` | Domain specifics, applied *in addition to* `20-lens.md`. |

## Domain contracts

| Contract | Applies when |
|---|---|
| `lenses/ci-cd-github-actions.md` | `.github/workflows/` present |
| `lenses/iac-terraform.md` | `*.tf` present |
| `lenses/runtime-platform-eks.md` | EKS cluster or Kubernetes manifests present |

A domain contract adds what a generic reading would miss: the first-principles
derivation for that technology, the specific things to extract, the patterns
worth naming, and the gotchas that are worth raising *only where they can be
cited in the repository at hand*.

Adding a domain is writing one of these files. No code changes.

## The rule that matters most

> A claim that cannot be anchored to a knowledge-base node id or a `file:line`
> is not stated. It becomes an `openQuestion`.

Everything else is elaboration. A generated architecture document that mixes
verifiable structure with confident invention teaches things that are not true,
and the reader has no way to tell which half is which.

The corollary: **general engineering knowledge needs no citation.** Explaining
what a managed control plane is, or why signed tokens cannot be revoked, is not
a claim about this repository. Claims about *this system* need evidence; claims
about *how the world works* need only to be correct.

## Writing a new domain contract

Copy the shape of an existing one:

1. **Front matter** — `id`, `version`, `domain`, `inherits`.
2. **First-principles derivation** — problem → naive → failure → resolution →
   cost, written so someone who has never used the technology can follow it. No
   product name until `resolution`.
3. **What to extract** — a table of the specific things to find.
4. **Patterns to name** — the recurring structures a reader should learn to
   recognise elsewhere.
5. **Required sections** — usually a `config-anatomy` over the file that *is* the
   subject, and a `walkthrough` or `topology`.
6. **Gotchas** — with the standing instruction to raise them only where citable.
7. **Invariants to look for** — with honest `enforcement` values.

The test of a good domain contract: a reader who has never used the technology
finishes the lens able to evaluate whether it was the right choice — not merely
able to describe what was configured.
