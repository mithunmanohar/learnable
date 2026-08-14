---
id: lens.eks
version: 0.1.0
domain: runtime-platform
inherits: 00-conventions.md, 20-lens.md
---

# Domain contract: EKS and Kubernetes as a runtime platform

Applies when an EKS cluster resource, Kubernetes manifests, or Helm charts are
present. Adapt the vendor specifics for GKE or AKS; the derivation is identical
because the trade-off is the same.

This is the lens where the reader is most likely to be told *what* was deployed
and never *why any of it exists*. Spend the effort here.

## First-principles section 1: why an orchestrator at all

Derive before naming Kubernetes:

- **problem** — you have more containers than machines, machines fail, and
  containers must keep running somewhere with a stable way to reach them.
- **naive** — decide placement yourself: this container on that host, a process
  supervisor to restart it, a load balancer configured by hand.
- **failure** — a host dies at 3am and its containers do not come back, because
  the thing that would restart them died with the host. Scaling means editing
  the load balancer. Nothing reconciles intent with reality, so every deviation
  needs a human.
- **resolution** — declare desired state (*ten of these, reachable here*) and
  run a control loop that continuously compares it against observed state and
  acts to close the gap. Recovery stops being an incident and becomes the loop's
  ordinary behaviour.
- **cost** — a large amount of machinery, and a new failure surface. Debugging
  changes shape: the question is no longer "did my command work" but "why does
  the controller believe this is correct". Fighting the loop by changing things
  by hand never works, because it reverts them — correctly.

## First-principles section 2: why *managed* (this is the EKS-specific one)

- **problem** — the control plane (API server, etcd, scheduler, controller
  manager) is itself a distributed system that must be highly available,
  upgraded, backed up and secured.
- **naive** — run it yourself; it is just more nodes.
- **failure** — etcd is a consensus store with real operational demands. Losing
  quorum loses the cluster; upgrades must be sequenced across components; a
  control-plane outage means no deployments and no self-healing. This is a
  full-time responsibility, and it is not the thing your product is about.
- **resolution** — rent it. The provider runs the control plane across
  availability zones, patches it, and exposes an endpoint. You supply only the
  nodes that run your workloads.
- **cost** — a per-cluster fee whether or not anything runs on it; version
  availability on the provider's schedule, not yours, with forced upgrade
  windows; no access to control-plane flags, so some configuration is simply
  unavailable; and a hard dependency on one provider's IAM and networking model,
  which is the substantial part of the lock-in.
- **alternatives** — self-managed (`whenBetter`: you need control-plane
  configuration the provider does not expose, or operate at a scale where the
  per-cluster fee dominates); a serverless container runtime such as ECS Fargate
  or Cloud Run (`whenBetter`: workloads are ordinary long-running services and
  you do not need Kubernetes' extensibility — far less to learn and operate).

**Explicitly state what the reader still owns**: node lifecycle and patching,
capacity and cost, networking, RBAC, workload configuration, and everything
about their own applications. "Managed" is narrower than it sounds, and readers
consistently overestimate it.

## What to extract

| | |
|---|---|
| **Cluster** | version, endpoint public/private, control-plane logging |
| **Compute** | managed node groups vs self-managed vs Fargate; instance types; min/max/desired; spot or on-demand |
| **Networking** | VPC, subnet layout, whether nodes are in private subnets, the CNI in use |
| **Identity** | IRSA / Pod Identity — how a pod gets AWS permissions without static keys |
| **Ingress** | ALB controller, NGINX, Gateway API; how traffic enters |
| **Add-ons** | CoreDNS, kube-proxy, VPC CNI, EBS CSI driver, autoscaler |
| **Workloads** | Deployments, replicas, resource requests/limits, probes, PDBs |
| **Access** | `aws-auth` ConfigMap or access entries mapping IAM to RBAC |

## Required `topology` section: how a packet reaches a pod

The single most valuable section in this lens. Trace the full path and diagram
it:

```
client → DNS → ALB/NLB (public subnet) → target group
      → node (private subnet) → kube-proxy/iptables → Service → Pod
```

Name, for **this** repository, which subnets are public, which are private, what
the security groups permit, and how the load balancer was created — an Ingress
or Service annotation producing it via a controller is the part that surprises
people, because the load balancer exists in AWS but is declared in Kubernetes.

## First-principles: IRSA, when present

Worth its own derivation, because it is the mechanism readers most often
cargo-cult:

- **problem** — a pod needs AWS permissions. The node has an instance role, so
  the pod could just use that.
- **naive** — give the node role the permissions the pods need.
- **failure** — every pod on that node gets them. A compromised sidecar reads
  your buckets, and permissions can only be scoped per node, not per workload.
- **resolution** — the cluster gets an OIDC provider trusted by IAM; a service
  account is annotated with a role; the pod receives a projected token it
  exchanges for short-lived credentials for exactly that role.
- **cost** — several moving parts (OIDC provider, trust policy, annotation,
  SDK support) that fail in ways whose error messages do not point at the
  misconfigured piece. Credentials also expire, so long-running processes must
  handle refresh.

## Failure modes to populate

Emit `artifact.failureModes[]` for each you can ground:

- a node dies — pods rescheduled if capacity exists; **if not, they stay
  Pending**, which is where cluster-autoscaler configuration matters
- the control plane is unreachable — running pods keep running; no deploys,
  no rescheduling, no scaling
- a pod without resource `limits` — a memory leak can evict its neighbours
- no `PodDisruptionBudget` — a node drain during upgrade can take every replica
  at once
- missing or wrong `readinessProbe` — traffic routed to a pod that is not ready,
  producing errors only during deploys
- single-AZ node group — an AZ outage is a total outage

## Invariants to look for

- Nodes are in private subnets; only load balancers are public.
- Every workload sets resource requests (without them the scheduler is guessing).
- Pods obtain AWS permissions via IRSA, never static keys in secrets.
- Replicas > 1 with a PDB for anything meant to survive a node drain.

Record `enforcement` honestly — most of these are `convention` or `unenforced`
unless an admission controller or policy engine is present, and saying so is the
useful part.
