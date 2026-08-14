---
id: curriculum
version: 0.1.0
spine: default@0.1.0
produces: artifact.curriculum
inherits: 00-conventions.md
---

# Contract: building the curriculum

The last pass. Runs after all lenses are filled, because a curriculum is an
*ordering over material that already exists* — every lesson points into lenses,
traces and nodes rather than restating them.

## The default spine

Instantiate all eight for any non-trivial system. Emit a lesson even when the
answer is "this system does not do that" — an absence, named, is knowledge.

| # | intent | Question template |
|---|---|---|
| 1 | `purpose` | What problem does this system solve, and for whom? |
| 2 | `structure` | What are the major subsystems? |
| 3 | `boundaries` | Why are they separated *there*? |
| 4 | `behavior` | How does one request flow all the way through? |
| 5 | `failure` | What happens when *X* fails? |
| 6 | `technology-choice` | Why *Y* rather than the obvious alternative? |
| 7 | `invariants` | What must never be violated? |
| 8 | `implementation` | Now inspect the code. |

Rewrite each template to name **this** system's actual components. Lesson 6's
question should read "Why does ingest use Kafka rather than an HTTP call?", not
the template. A generic question signals a generic answer and gets skipped.

For a system with several major subsystems, lessons 4–6 may repeat per
subsystem. Keep the total under about fifteen.

## Why implementation is last

This ordering is the framework's central pedagogical claim, and it inverts every
documentation tool.

Starting at the code means every design decision arrives as an unexplained fact.
The reader ends up able to *navigate* the system without *understanding* it —
which is precisely the position an experienced engineer is in when an agent
writes their codebase, and precisely what this framework exists to fix.

Code read after lessons 1–7 is read as the answer to questions the reader is
already holding. Do not reorder this.

## Per-lesson requirements

### The question

The lesson **is** its question. "Authentication" is a topic to skim; "Can this
system log out a stolen session?" is a question to answer.

### `predictProbe` — before anything is revealed

The mechanism of the whole curriculum. The reader commits an answer before
seeing the narrative or the code.

Requirements:

- Answerable from the *previous* lessons plus general engineering knowledge —
  it is a prediction, not a quiz on unseen material.
- A plausible wrong answer must exist. If everyone gets it right, it teaches
  nothing.
- Fill `commonWrongAnswer` with that plausible mistake **and why it is wrong**.
  This is usually the highest-value text in the lesson.
- The question must not give away its own answer.

Good: *"This endpoint takes a list of items and writes each to the database.
Before you look — how many SQL statements do you think run for a request with
fifty items?"*

Bad: *"Does this endpoint have an N+1 query problem?"*

### `narrative`

The explanation, shown after the prediction is committed. Point into lenses and
sections rather than repeating them; this is the connective tissue, not a
duplicate of the material.

Where the reader's likely prediction was wrong, address the wrong answer
directly — that is the moment the lesson lands.

### `reveal`

What the viewer discloses after the prediction: a lens, specific sections, a
trace to play, nodes to highlight, source ranges to open. This is the payoff, so
make it specific — a reveal pointing at a whole lens is a reveal pointing at
nothing.

### `prerequisiteConceptIds`

Catalog concepts the lesson assumes. The viewer offers these first to a reader
who has not met them, which is how the framework adapts to what someone already
knows instead of assuming a uniform starting point.

### `masteryChecks`

One to three probes of kind `recall`, `apply` or `diagnose`, answerable only if
the lesson landed. Prefer `apply` and `diagnose` over `recall` — retrieving a
fact is weaker evidence of understanding than transferring it to a situation the
lesson did not cover.

## Lesson-specific notes

**Lesson 3 (`boundaries`)** is the hardest and most valuable. Ask why the seams
are *where they are* — why this service split, why this module edge, why this
table separate. An agent-built system has boundaries nobody deliberated over;
where you cannot find a reason, say so plainly and record an `openQuestion`. An
honest "this boundary appears incidental" is more useful than an invented
rationale, and it tells the reader where to be careful.

**Lesson 5 (`failure`)** draws on `artifact.failureModes[]`. Choose the
component whose failure is most instructive, not the most likely — usually the
one whose blast radius surprises people.

**Lesson 6 (`technology-choice`)** requires a real alternative with a real
`whenBetter`. If the choice was arbitrary or conventional, say that — "this is
the default for this framework and nothing here depends on it" is a legitimate
and clarifying answer.

**Lesson 8 (`implementation`)** finally directs the reader to code. Give a
reading order — entry point first, then the path a request takes, then the data
model — and tell them what to look for at each stop. Do not simply list files.

## Budget

Eight to fifteen lessons. Narrative 200–500 words each. Set
`estimatedMinutes` per lesson and sum into `curriculum.estimatedMinutes`.
