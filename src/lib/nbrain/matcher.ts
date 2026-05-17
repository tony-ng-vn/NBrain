import type { DocClaim, MergedPrEvent } from "./schemas";

export type ClaimMatch = {
  claim: DocClaim;
  score: number;
  reasons: string[];
};

export function rankClaimsForPr(event: MergedPrEvent, claims: DocClaim[]): ClaimMatch[] {
  const corpus = `${event.title} ${event.body ?? ""} ${event.changedFiles.join(" ")}`.toLowerCase();

  return claims
    .map((claim) => {
      const reasons: string[] = [];
      let score = 0;

      for (const path of claim.coveredPaths) {
        if (event.changedFiles.some((file) => pathsOverlap(file, path))) {
          score += 100;
          reasons.push(`path:${path}`);
        }
      }

      for (const concept of claim.concepts) {
        if (concept.length > 1 && corpus.includes(concept.toLowerCase())) {
          score += 12;
          reasons.push(`concept:${concept}`);
        }
      }

      for (const evidence of claim.evidenceRefs) {
        if (event.changedFiles.some((file) => pathsOverlap(file, evidence))) {
          score += 25;
          reasons.push(`evidence:${evidence}`);
        }
      }

      return { claim, score, reasons };
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score);
}

function pathsOverlap(changedFile: string, claimPath: string): boolean {
  const normalizedChanged = normalizePath(changedFile);
  const normalizedClaimPath = normalizePath(claimPath);

  if (!normalizedChanged || !normalizedClaimPath) {
    return false;
  }

  return (
    normalizedChanged === normalizedClaimPath ||
    normalizedChanged.startsWith(`${normalizedClaimPath}/`) ||
    normalizedClaimPath.startsWith(`${normalizedChanged}/`)
  );
}

function normalizePath(path: string): string {
  return path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}
