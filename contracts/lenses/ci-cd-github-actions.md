---
id: lens.github-actions
version: 0.1.0
domain: ci-cd
inherits: 00-conventions.md, 20-lens.md
---

# Domain contract: GitHub Actions

Applies when `.github/workflows/*.yml` is present.

## First-principles section: what CI/CD is for

Derive it, do not assume it:

- **problem** — code that works on the machine that wrote it says nothing about
  whether it works anywhere else, and the gap is only discovered by someone
  else, later, usually at the worst time.
- **naive** — a checklist: run the tests, build, upload. Discipline instead of
  machinery.
- **failure** — checklists are executed by people under time pressure. Steps get
  skipped, environments differ, and "works on my machine" is a class of outage,
  not a joke. Nothing records what was actually run against what.
- **resolution** — move the checklist into a machine that runs it identically on
  every change, from a clean environment, with a durable record of the result.
- **cost** — a second environment to maintain and debug, feedback that arrives
  in minutes rather than seconds, and a new failure class where the pipeline is
  broken while the code is fine. Hosted runners also mean your build depends on
  someone else's availability.

## What to extract

Walk every workflow file and establish:

| | |
|---|---|
| **Triggers** | `on:` — push, PR, tag, schedule, `workflow_dispatch`. Which branches and paths. |
| **Job graph** | `needs:` dependencies. This is the real structure — emit it as a `topology` diagram. |
| **Runner** | hosted vs self-hosted, OS, whether pinned or floating |
| **Permissions** | `permissions:` block, and `id-token: write` in particular |
| **Secrets** | which are referenced and where they come from (repo, environment, OIDC) |
| **Environments** | `environment:` and any protection rules implied |
| **Caching** | `actions/cache`, setup-action caches, and what the cache key covers |
| **Concurrency** | `concurrency:` groups and `cancel-in-progress` |
| **Action pins** | `@v4` vs a commit SHA |

## Required `config-anatomy` section

The most important workflow — usually the deploy — gets an `annotatedSource`
section covering **every meaningful block**. This is the "show me what each part
of this file is doing" requirement, and it is the section readers use most.

Annotate what a block accomplishes and why it is needed. Never restate the YAML.

Mark `importance: critical` on anything with security or correctness weight:
permissions, OIDC/credential steps, environment gates, `if:` conditions guarding
deploys.

### Gotchas to raise where present

Only where you can cite them in this repository:

- **Actions pinned to a moving tag.** `@v4` is a tag that can be repointed, so a
  compromised or changed action executes with your workflow's permissions.
  Pinning to a commit SHA is the mitigation, and its cost is manual updates.
- **`pull_request_target` with checkout of the PR head.** Runs untrusted code
  with access to secrets. If present, this is `critical` and the single most
  important thing in the lens.
- **Over-broad `permissions`.** The default token grants more than most jobs
  need; `contents: read` plus explicit additions is the tighter pattern.
- **Long-lived cloud credentials in secrets** where OIDC federation would work.
  Static keys do not expire and do not rotate themselves.
- **Missing `concurrency`** on deploy workflows, allowing two deploys of
  different commits to race.
- **Cache keys that omit the lockfile**, serving stale dependencies.
- **`continue-on-error`** on a step whose failure ought to stop the pipeline.

## Required `walkthrough` section

"What happens when I push to the default branch" — the full sequence from event
to deployed artifact, naming each job, its gates, and its duration if
discoverable. This is what a new engineer actually needs on day one.

## Invariants to look for

- Deploys occur only from a specific branch or tag pattern.
- Tests must pass before deploy (verify via `needs:`, not by assumption — a job
  that merely runs *later* is not gated).
- Production deploys require an environment approval.

State the `enforcement` honestly. "The workflow is ordered this way" is
`convention`; a required status check or an environment protection rule is
enforced. The difference decides whether someone can push straight past it.
