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
  const coveredPaths = extractReferencePaths(markdown);
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
      coveredPaths,
      concepts: concepts.length > 0 ? concepts : ["repository", "guide"],
      dependencyClaimIds: [],
      evidenceRefs: coveredPaths,
      confidence: 0.35,
      staleStatus: "fresh",
    },
  ];
}

function extractReferencePaths(markdown: string): string[] {
  const matches = markdown.matchAll(
    /(?:`([^`\n]+\.[A-Za-z0-9]+[^`\n]*)`)|\b((?:README\.md|package\.json|[A-Za-z0-9_.-]+\/[A-Za-z0-9_./@-]+\.[A-Za-z0-9]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9]+))\b/g,
  );
  const paths = Array.from(matches)
    .map((match) => (match[1] ?? match[2] ?? "").trim())
    .map((path) => path.replace(/[),.:;]+$/, ""))
    .filter((path) => path.length > 0)
    .filter((path) => !path.startsWith("http"))
    .filter((path) => !path.includes("github.com"))
    .filter((path) => !path.includes(".."))
    .filter((path) => !path.startsWith("."))
    .filter((path) => !path.endsWith(".com"))
    .filter((path) => path === "README.md" || path.includes("/") || path === "package.json" || path.includes("config"))
    .slice(0, 8);

  return Array.from(new Set(paths)).slice(0, 8).filter(Boolean).length > 0
    ? Array.from(new Set(paths)).slice(0, 8)
    : ["README.md"];
}
