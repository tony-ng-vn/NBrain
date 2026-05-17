import { randomUUID } from "node:crypto";
import {
  ClaimExtractionResponseSchema,
  type ClaimExtractionResponse,
  type DocClaim,
} from "./schemas";

export function parseClaimExtractionResponse(value: unknown): ClaimExtractionResponse {
  return ClaimExtractionResponseSchema.parse(value);
}

export function materializeClaims(
  sectionId: string,
  response: ClaimExtractionResponse,
): DocClaim[] {
  return response.claims.map((claim) => ({
    id: randomUUID(),
    sectionId,
    text: claim.text,
    kind: claim.kind,
    coveredPaths: claim.coveredPaths,
    concepts: claim.concepts,
    dependencyClaimIds: claim.dependencyClaimIds,
    evidenceRefs: claim.evidenceRefs,
    confidence: claim.confidence,
    staleStatus: "fresh",
  }));
}

export function fallbackClaimsFromMarkdown(sectionId: string, markdown: string): DocClaim[] {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1] ?? "Repo Guide";
  const concepts = Array.from(
    new Set(
      markdown
        .toLowerCase()
        .split(/[^a-z0-9/_-]+/)
        .filter((token) => token.length > 4)
        .slice(0, 8),
    ),
  );

  return [
    {
      id: randomUUID(),
      sectionId,
      text: `${title} describes the repository behavior and primary implementation paths.`,
      kind: "concept",
      coveredPaths: ["README.md"],
      concepts: concepts.length > 0 ? concepts : ["repository", "guide"],
      dependencyClaimIds: [],
      evidenceRefs: ["README.md"],
      confidence: 0.35,
      staleStatus: "fresh",
    },
  ];
}
