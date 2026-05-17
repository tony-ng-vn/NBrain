import { PatchProposalSchema, type DocClaim, type DocSection } from "./schemas";

export type VerificationContext = {
  claimsById: Record<string, DocClaim>;
  sectionsById: Record<string, DocSection>;
  impactedClaimIds: string[];
  changedFiles: string[];
  currentRenderedHashes?: Record<string, string>;
};

export type VerificationResult =
  | {
      accepted: true;
      requiresReview: false;
      reasons: string[];
    }
  | {
      accepted: false;
      requiresReview: boolean;
      reasons: string[];
      reviewTask?: {
        sectionId?: string;
        claimIds: string[];
        reason: string;
        unresolvedQuestion: string;
      };
    };

export function verifyPatchProposal(
  proposalValue: unknown,
  context: VerificationContext,
): VerificationResult {
  const parsed = PatchProposalSchema.safeParse(proposalValue);

  if (!parsed.success) {
    return {
      accepted: false,
      requiresReview: false,
      reasons: ["patch_schema_invalid"],
    };
  }

  const proposal = parsed.data;
  const impactedClaimIds = new Set(context.impactedClaimIds);
  const impactedSectionIds = new Set(
    context.impactedClaimIds
      .map((claimId) => context.claimsById[claimId]?.sectionId)
      .filter(Boolean),
  );
  const reasons: string[] = [];

  for (const operation of proposal.operations) {
    if (operation.type === "skip") {
      reasons.push(`skip:${operation.reason}`);
      continue;
    }

    if (operation.type === "create_review_task") {
      continue;
    }

    if (operation.type === "update_claim" || operation.type === "mark_claim_stale") {
      if (!context.claimsById[operation.claimId]) {
        return reject("unknown_claim");
      }

      if (!impactedClaimIds.has(operation.claimId)) {
        return reject("claim_not_impacted");
      }
    }

    if (operation.type === "add_claim") {
      if (!context.sectionsById[operation.sectionId]) {
        return reject("unknown_section");
      }

      if (!impactedSectionIds.has(operation.sectionId)) {
        return reject("section_not_impacted");
      }
    }

    if (operation.type === "replace_section") {
      const section = context.sectionsById[operation.sectionId];

      if (!section) {
        return reject("unknown_section");
      }

      if (!impactedSectionIds.has(operation.sectionId)) {
        return reject("section_not_impacted");
      }

      if (operation.removedClaimIds.length > 0) {
        return reject("auto_remove_not_allowed");
      }

      const currentHash =
        context.currentRenderedHashes?.[operation.sectionId] ?? section.renderedNotionHash;

      if (currentHash !== operation.expectedRenderedHash) {
        return {
          accepted: false,
          requiresReview: true,
          reasons: ["target_user_edited_content"],
          reviewTask: {
            sectionId: operation.sectionId,
            claimIds: context.impactedClaimIds,
            reason: "The managed Notion section changed since NBrain last rendered it.",
            unresolvedQuestion: "Should NBrain overwrite the user-edited Notion content?",
          },
        };
      }
    }
  }

  return {
    accepted: true,
    requiresReview: false,
    reasons,
  };

  function reject(reason: string): VerificationResult {
    return {
      accepted: false,
      requiresReview: false,
      reasons: [reason],
    };
  }
}
