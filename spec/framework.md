# The Learnable framework

A framework for turning a repository into a **first-principles learning engine** —
not documentation of it.

The distinction matters and it is the reason this exists. Documentation
frameworks describe a system to a reader who is assumed to already understand
its parts: they will tell you the service uses EKS, and take for granted that
you know what a managed control plane is, why one would want it, and what it
costs. That assumption is exactly what fails when an agent wrote the system and
chose components you have never operated.

Learnable inverts it. Every component is explained from the problem that forces
it to exist, and implementation is the **last** thing you are shown.

---

## The four layers

Each layer answers one question, depends on the layer beneath it, and is
produced by a different mechanism.

| Layer | Question | Content | Produced by |
|---|---|---|---|
| **1. Structural** | What exists? | services, modules, datastores, queues, APIs, dependencies, infra resources | Deterministic extractor |
| **2. Behavioral** | What happens? | request paths, event flows, job lifecycles, startup, failure paths | Extractor (traces) + analyst |
| **3. Design** | Why is it built this way? | constraints, trade-offs, patterns, invariants, failure handling, consistency models, scaling assumptions, security boundaries | Analyst, grounded in 1–2 |
| **4. Learning model** | How should a human learn this? | an ordered curriculum with prerequisites, predictions and drill-downs | Analyst, grounded in 1–3 |

Layers 1 and 2 are *facts about the system*. Layers 3 and 4 are *the product*.
A tool that stops at Layer 2 is a code-intelligence tool, and there are many.

---

## Two engines, and why both

Layers 3 and 4 cannot be extracted. No syntax tree contains the reason EKS was
chosen over ECS, what each step of a workflow accomplishes, or which invariant
must never be violated. That requires reasoning and domain knowledge, which
means a language model.

But a language model turned loose on a repository produces confident, fluent,
partly-false architecture — the single most damaging possible output, because
the reader cannot tell which parts are wrong and is learning from all of it.

So: **two engines with different jobs.**

```
  repository ──► EXTRACTOR ──► kb.json          Layers 1–2. Deterministic,
                 (AST, manifests,               verifiable, cheap to regenerate.
                  IaC, git history)             Every node carries file:line.
                                    │
                                    ▼
  repository ──► ANALYST ─────► artifact.json   Layers 3–4. Contract-driven,
  + docs         (LLM, driven by                must cite the KB or the source.
                  contracts/)                   Everything badged `inferred`.
                                    │
                                    ▼
                                 VIEWER          Renders the artifact, always
                                                 showing provenance and evidence.
```

The extractor's most important job is not producing a graph. **It is being the
thing the analyst is required to cite.** The binding rule, enforced by every
contract:

> A claim the analyst cannot anchor to a KB node id or a `file:line` is not
> stated. It is emitted as an **open question**.

That single rule is what separates this from a plausible-sounding wiki.

---

## Lenses: cross-sections, not folders

A repository is not understood by reading it in directory order. It is
understood by looking at it through several viewpoints, each at its own level of
abstraction. A **lens** is one such cross-section.

For a repository that deploys an EKS cluster with Terraform via GitHub Actions,
the lenses are not `.github/`, `terraform/`, `k8s/`. They are:

| Lens | The question it answers |
|---|---|
| `ci-cd` | What happens when I push? What does each workflow step actually accomplish? |
| `iac` | How is infrastructure described, and which Terraform patterns are in use? |
| `runtime-platform` | What is the cluster, and what does a managed control plane give and cost? |
| `network` | How does a packet from the internet reach a pod? |
| `security` | What can assume which identity, and where are the trust boundaries? |

Crucially, `runtime-platform` explains **EKS from first principles** — the
problem a managed Kubernetes control plane solves, what you would do without it,
what breaks, and what you pay — before it says anything about how this
repository configures it. That ordering is the framework.

A lens declares which concepts it requires, so the curriculum can order
prerequisites correctly.

---

## Progressive disclosure: the artifact is a lazy tree

"Explore further on demand" is a structural requirement, not a UI nicety.

Every section has a `depth` (`overview` → `working` → `deep`) and may carry
children that are either already generated or **stubs** naming the contract that
would generate them. Opening a stub is what triggers generation.

This matters twice over. It keeps generation cost proportional to what is
actually read, and it keeps the top level short enough to be read at all — a
fully-expanded artifact for a real system is a book nobody opens.

### Annotated source

A recurring need — *"show the workflow file and what each part of it does"* — is
a distinct content type rather than prose: a source file plus line-range
annotations. It is how config-heavy domains (workflows, Terraform, manifests)
are taught, because the artifact under discussion *is* the file.

---

## The lesson spine

Layer 4 is an ordered curriculum. The default spine, which the analyst
instantiates for each repository:

| # | Intent | The lesson's question |
|---|---|---|
| 1 | `purpose` | What problem does this system solve, and for whom? |
| 2 | `structure` | What are the major subsystems? |
| 3 | `boundaries` | Why are they separated *there* and not elsewhere? |
| 4 | `behavior` | How does one request flow all the way through? |
| 5 | `failure` | What happens when component X fails? |
| 6 | `technology-choice` | Why does Y use Kafka rather than HTTP? |
| 7 | `invariants` | What assumptions must never be violated? |
| 8 | `implementation` | Now inspect the code. |

Two properties of this ordering are load-bearing:

**Implementation is last.** Every documentation framework starts at the code.
Starting there means every design decision arrives as an unexplained fact, and
the reader ends up able to navigate the system without understanding it. Code
read *after* lessons 1–7 is read as the answer to questions you already hold.

**Each lesson is a question, not a topic.** A lesson titled "Authentication" is
something to skim. A lesson titled "A user's laptop is stolen mid-session — can
this system log them out?" is something to answer, and answering is what makes
it stick.

### Predict, then reveal

Each lesson asks its question **before** disclosing the relevant code or
diagram. The reader commits an answer, then sees the evidence. Being wrong is
the mechanism — it is the moment the concept is actually acquired, and it is
unavailable to anyone who read the answer first.

---

## First principles, for patterns *and* technologies

The catalog's derivation shape applies unchanged to both:

```
problem     the constraint in the world that forces the issue
naive       what you would obviously try first
failure     the concrete scenario where that breaks
resolution  the technique, as a response to that failure
cost        what you gave up to get it
```

For a pattern (`idempotency`) and for a technology (`EKS`, `Terraform remote
state`, `GitHub Actions`) alike. A technology explained this way transfers: once
you know a managed control plane trades operational burden for version lag,
loss of control and per-cluster cost, you understand GKE and AKS as well, and
you can evaluate the next one.

`cost` is mandatory. A technique or product taught without its cost produces
cargo-culting, which is the characteristic failure of generated architecture
documents.

---

## Layer separation is what makes this reusable

The four layers are separate artifacts with separate lifetimes:

- **`kb.json`** — regenerated every scan, thrown away with the repo.
- **`artifact.json`** — regenerated when the system changes materially.
- **`catalog/concepts.json`** — **accumulates across every repository you ever
  scan**, and is the only one of the three you would be sad to lose.

Meeting *optimistic concurrency* for the third time, in a third system, is what
turns it from something you have read into something you know. That is only
possible because the concept layer does not live inside any one repository's
knowledge base.
