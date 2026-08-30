import { KBBuilder } from "../kb/builder.js";
import type { Decision, SourceRef, StackItem } from "../kb/types.js";

const EXTRACTOR = "synth.decisions@0.1.0";

/**
 * Reconstructs architectural decisions from what the code actually chose.
 *
 * These are stated as observations with their real trade-offs, never as
 * endorsements. The value is not "your stack is good" — it is seeing that a
 * choice was made at all, and what it cost, because that is the part an agent
 * makes silently and a reader would otherwise never notice.
 */
export function deriveDecisions(kb: KBBuilder): void {
  const stack = new Map(kb.allStackItems().map((s) => [s.name.toLowerCase(), s]));
  const has = (name: string): StackItem | undefined => stack.get(name.toLowerCase());
  const evidenceOf = (...names: string[]): SourceRef[] =>
    names.flatMap((n) => has(n)?.provenance.evidence ?? []);

  const decisions: Decision[] = [];

  const jwtLib = has("python-jose") ?? has("pyjwt") ?? has("jsonwebtoken");
  if (jwtLib) {
    decisions.push({
      id: "decision.stateless-auth",
      title: "Authentication is stateless, carried in a signed token",
      chosen:
        `Tokens are signed with ${jwtLib.name}. The server verifies a signature on each ` +
        `request instead of looking a session up in a store.`,
      alternatives: [
        {
          option: "Server-side sessions in a database or Redis",
          whyNot:
            "Requires a round trip to shared state on every request, and a store that must " +
            "stay available for anyone to stay logged in.",
        },
      ],
      tradeoffs: [
        "No session lookup, so any instance can serve any request with no shared state — this is what makes horizontal scaling straightforward.",
        "Revocation is the price: a token stays valid until it expires, because nothing is consulted that could mark it dead. Logout only discards the client's copy.",
        "The token is readable by anyone holding it — signing proves integrity, not confidentiality — so it must never carry secrets.",
      ],
      conceptIds: ["concept.stateless-auth", "concept.password-hashing"],
      provenance: {
        method: "inferred", extractor: EXTRACTOR, confidence: 0.85,
        evidence: evidenceOf(jwtLib.name),
        note: "Inferred from the dependency set. The trade-offs are properties of the technique, not measurements of this codebase.",
      },
    });
  }

  const orm = has("sqlmodel") ?? has("sqlalchemy") ?? has("prisma") ?? has("@prisma/client") ?? has("drizzle-orm");
  if (orm) {
    decisions.push({
      id: "decision.orm",
      title: `Database access goes through ${orm.name} rather than raw SQL`,
      chosen: `Tables are declared as ${orm.name} classes and queried through its expression API.`,
      alternatives: [
        {
          option: "Hand-written SQL with a thin driver",
          whyNot: "More code for ordinary operations, and no single place where table shape is defined.",
        },
      ],
      tradeoffs: [
        "One definition produces the table, the validation and the editor's autocomplete, so the three cannot drift apart.",
        "The SQL that actually runs is generated and not visible at the call site, which is how N+1 query patterns get shipped without anyone noticing.",
        "Anything the query API cannot express has to drop to raw SQL anyway.",
      ],
      conceptIds: ["concept.orm-mapping", "concept.n-plus-one"],
      provenance: {
        method: "inferred", extractor: EXTRACTOR, confidence: 0.85,
        evidence: evidenceOf(orm.name),
      },
    });
  }

  if (has("sqlmodel")) {
    const dtoCount = kb.nodesOfKind("dataModel").filter((n) => !n.attrs?.persisted).length;
    const tableCount = kb.nodesOfKind("dataModel").filter((n) => n.attrs?.persisted).length;
    if (tableCount > 0 && dtoCount > tableCount) {
      decisions.push({
        id: "decision.dto-projection",
        title: "API shapes are separate types from database tables",
        chosen:
          `${tableCount} persisted table model(s) sit alongside ${dtoCount} non-persisted shapes ` +
          `(Create / Update / Public variants) that define what crosses the API boundary.`,
        alternatives: [
          {
            option: "Serialise the table model directly",
            whyNot:
              "Every column becomes part of the public contract, including the ones you did not mean to publish.",
          },
        ],
        tradeoffs: [
          "The hashed password column cannot leak through an endpoint, because the response type has no field to put it in.",
          "Input and output shapes evolve independently of the table.",
          "More types to keep in step; a new column has to be added in several places to become visible.",
        ],
        conceptIds: ["concept.dto-projection", "concept.boundary-validation"],
        provenance: {
          method: "inferred", extractor: EXTRACTOR, confidence: 0.9,
          evidence: kb.nodesOfKind("dataModel").slice(0, 3).flatMap((n) => (n.location ? [n.location] : [])),
          note: `Counted ${tableCount} persisted and ${dtoCount} non-persisted models.`,
        },
      });
    }
  }

  const queryLib = has("@tanstack/react-query") ?? has("@tanstack/query") ?? has("swr");
  if (queryLib) {
    decisions.push({
      id: "decision.server-state-cache",
      title: "Server data is held in a cache, not in component state",
      chosen: `${queryLib.name} owns fetched data, keyed by query key, outside the component tree.`,
      alternatives: [
        {
          option: "useState plus useEffect per component",
          whyNot:
            "Each component fetches its own copy, and nothing coordinates them, so the same data " +
            "is requested repeatedly and goes stale independently.",
        },
      ],
      tradeoffs: [
        "Loading and error states, deduplication and refetching stop being hand-written in every component.",
        "Freshness becomes an explicit decision: something has to invalidate a key, and forgetting to is the classic 'why is the list stale after I added a row' bug.",
        "The cache is a second source of truth that has to be reasoned about alongside the server.",
      ],
      conceptIds: ["concept.server-state-cache", "concept.cache-invalidation"],
      provenance: {
        method: "inferred", extractor: EXTRACTOR, confidence: 0.85,
        evidence: evidenceOf(queryLib.name),
      },
    });
  }

  const generatedClient = kb.allNodes().some(
    (n) => n.kind === "file" && n.attrs?.generated === true && /client|sdk|api/i.test(n.name + n.id),
  );
  if (generatedClient) {
    decisions.push({
      id: "decision.generated-client",
      title: "The frontend's API client is generated from the backend's schema",
      chosen:
        "Request functions and response types are generated from the server's OpenAPI document " +
        "rather than written by hand.",
      alternatives: [
        {
          option: "Hand-written fetch wrappers and duplicated types",
          whyNot: "The two sides drift, and nothing detects it until runtime.",
        },
      ],
      tradeoffs: [
        "A breaking change on the server becomes a compile error in the frontend, which is the earliest place it can possibly be caught.",
        "Regeneration is a build step someone has to remember to run; a stale client looks correct and type-checks.",
        "Generated files are large and should be read as output, not as source.",
      ],
      conceptIds: ["concept.contract-first-api"],
      provenance: {
        method: "inferred", extractor: EXTRACTOR, confidence: 0.8,
        evidence: kb.allNodes()
          .filter((n) => n.kind === "file" && n.attrs?.generated === true)
          .slice(0, 2)
          .flatMap((n) => (n.location ? [n.location] : [])),
      },
    });
  }

  if (has("alembic")) {
    decisions.push({
      id: "decision.migrations",
      title: "Schema changes are versioned as migration scripts",
      chosen: "Alembic revisions record each schema change as an ordered, replayable script.",
      alternatives: [
        {
          option: "Create tables from the models at startup",
          whyNot:
            "Works only on an empty database. It cannot alter an existing table without losing what is in it.",
        },
      ],
      tradeoffs: [
        "Any environment can be brought to the current schema by replaying history, so production and a fresh checkout converge.",
        "The migration and the model are two descriptions of one thing, and they can disagree.",
        "Rolling back a migration that dropped a column does not bring the data back.",
      ],
      conceptIds: ["concept.schema-migration"],
      provenance: {
        method: "inferred", extractor: EXTRACTOR, confidence: 0.9,
        evidence: evidenceOf("alembic"),
      },
    });
  }

  for (const d of decisions) kb.addDecision(d);

  if (decisions.length === 0) {
    kb.addDiagnostic({
      level: "info", extractor: EXTRACTOR,
      message: "No architectural decisions were recognised from the detected stack.",
    });
  }
}
