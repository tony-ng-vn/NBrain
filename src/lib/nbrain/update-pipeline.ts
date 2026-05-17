import { buildPatchProposal } from "./openai";
import { fetchPullRequestFiles } from "./github-api";
import { stableHash } from "./hash";
import { rankClaimsForPr } from "./matcher";
import { createNotionAdapter, type NotionPort, type NotionWorkspace } from "./notion";
import {
  createDocUpdateRun,
  getImportRun,
  getLatestImportRun,
  replaceImportRunClaim,
  replaceImportRunSection,
  updateDocUpdateRun,
  type DocUpdateRun,
  type ImportRun,
  type ReviewTask,
} from "./run-store";
import type { DocClaim, DocSection, MergedPrEvent, PatchProposal } from "./schemas";
import { verifyPatchProposal } from "./verifier";

export type UpdatePipelineInput = {
  importRunId?: string;
  event: MergedPrEvent;
  weakEvidence?: boolean;
};

export type UpdatePipelineDeps = {
  notion?: NotionPort;
  fetchChangedFiles?: (event: MergedPrEvent) => Promise<string[]>;
  buildPatch?: (args: {
    event: MergedPrEvent;
    impactedClaims: DocClaim[];
    impactedSections: DocSection[];
    weakEvidence?: boolean;
  }) => Promise<PatchProposal>;
};

export async function runMergedPrUpdatePipeline(
  input: UpdatePipelineInput,
  deps: UpdatePipelineDeps = {},
): Promise<DocUpdateRun> {
  const importRun = resolveImportRun(input.importRunId);
  const updateRun = createDocUpdateRun(importRun.id);

  try {
    updateDocUpdateRun(updateRun.id, { status: "running", log: "Started merged PR update." });
    const changedFiles = await (deps.fetchChangedFiles ?? fetchPullRequestFiles)(input.event);
    const event: MergedPrEvent = {
      ...input.event,
      changedFiles,
    };

    const matches = rankClaimsForPr(event, importRun.claims);
    const impactedClaims = matches.slice(0, 8).map((match) => match.claim);
    const impactedClaimIds = impactedClaims.map((claim) => claim.id);
    const impactedSections = collectImpactedSections(importRun.sections, impactedClaims);
    const workspace = workspaceFromImportRun(importRun);
    const notion = deps.notion ?? createNotionAdapter();

    updateDocUpdateRun(updateRun.id, {
      event,
      changedFiles,
      impactedClaimIds,
      log: `Matched ${impactedClaimIds.length} impacted claim(s).`,
    });

    await notion.recordMergedPr({ workspace, event });

    if (impactedClaims.length === 0 || impactedSections.length === 0) {
      const task = await notion.createReviewTask({
        workspace,
        task: {
          title: `Review PR #${event.number}: ${event.title}`,
          reason: "No existing claim matched the changed files or PR concepts.",
          unresolvedQuestion: "Should this PR add a new claim or section to the Repo Guide?",
          prUrl: event.htmlUrl,
          changedFiles,
          affectedClaimIds: [],
          evidenceRefs: changedFiles,
        },
      });
      const completed = updateDocUpdateRun(updateRun.id, {
        status: "completed",
        reviewTasks: [task],
        log: "Created a review task because no impacted claims matched.",
      });
      await notion.recordDocUpdateRun({ workspace, run: completed });
      return completed;
    }

    const proposal = await (deps.buildPatch ?? buildPatchProposal)({
      event,
      impactedClaims,
      impactedSections,
      weakEvidence: input.weakEvidence,
    });
    const currentRenderedHashes = await collectCurrentRenderedHashes(notion, impactedSections);
    const verification = verifyPatchProposal(proposal, {
      claimsById: Object.fromEntries(importRun.claims.map((claim) => [claim.id, claim])),
      sectionsById: Object.fromEntries(importRun.sections.map((section) => [section.id, section])),
      impactedClaimIds,
      changedFiles,
      currentRenderedHashes,
    });

    if (!verification.accepted) {
      const task = await notion.createReviewTask({
        workspace,
        task: {
          title: `Review PR #${event.number}: ${event.title}`,
          reason: verification.reasons.join(", "),
          unresolvedQuestion:
            verification.reviewTask?.unresolvedQuestion ??
            "Can this documentation update be safely applied?",
          prUrl: event.htmlUrl,
          changedFiles,
          affectedClaimIds: verification.reviewTask?.claimIds ?? impactedClaimIds,
          evidenceRefs: changedFiles,
        },
      });
      const completed = updateDocUpdateRun(updateRun.id, {
        status: "completed",
        reviewTasks: [task],
        log: "Created a review task because verification blocked the patch.",
      });
      await notion.recordDocUpdateRun({ workspace, run: completed });
      return completed;
    }

    const appliedSectionIds: string[] = [];
    const reviewTasks: ReviewTask[] = [];

    for (const operation of proposal.operations) {
      if (operation.type === "replace_section") {
        const section = importRun.sections.find((candidate) => candidate.id === operation.sectionId);

        if (!section) {
          continue;
        }

        const renderedHash = await notion.replaceSectionContent(section, operation.markdown);
        const updatedSection: DocSection = {
          ...section,
          renderedMarkdown: operation.markdown,
          renderedNotionHash: renderedHash || stableHash(operation.markdown),
        };

        replaceImportRunSection(updatedSection);
        appliedSectionIds.push(section.id);
      }

      if (operation.type === "update_claim") {
        const claim = importRun.claims.find((candidate) => candidate.id === operation.claimId);

        if (claim) {
          replaceImportRunClaim({ ...claim, text: operation.text, evidenceRefs: operation.evidenceRefs });
        }
      }

      if (operation.type === "mark_claim_stale") {
        const claim = importRun.claims.find((candidate) => candidate.id === operation.claimId);

        if (claim) {
          replaceImportRunClaim({
            ...claim,
            staleStatus: operation.staleStatus,
            evidenceRefs: [...new Set([...claim.evidenceRefs, ...operation.evidenceRefs])],
          });
        }
      }

      if (operation.type === "create_review_task") {
        reviewTasks.push(
          await notion.createReviewTask({
            workspace,
            task: {
              title: `Review PR #${event.number}: ${event.title}`,
              reason: operation.reason,
              unresolvedQuestion: operation.unresolvedQuestion,
              prUrl: event.htmlUrl,
              changedFiles,
              affectedClaimIds: operation.claimIds,
              evidenceRefs: operation.evidenceRefs,
            },
          }),
        );
      }
    }

    const completed = updateDocUpdateRun(updateRun.id, {
      status: "completed",
      appliedSectionIds,
      reviewTasks,
      log:
        appliedSectionIds.length > 0
          ? `Applied ${appliedSectionIds.length} section update(s).`
          : `Created ${reviewTasks.length} review task(s).`,
    });

    await notion.recordDocUpdateRun({ workspace, run: completed });
    return completed;
  } catch (error) {
    return updateDocUpdateRun(updateRun.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown update failure.",
      log: "Merged PR update failed.",
    });
  }
}

function resolveImportRun(importRunId?: string): ImportRun {
  const importRun = importRunId ? getImportRun(importRunId) : getLatestImportRun();

  if (!importRun) {
    throw new Error("Import a repository before replaying a merged PR update.");
  }

  if (importRun.status !== "completed") {
    throw new Error("The selected import run has not completed.");
  }

  return importRun;
}

function collectImpactedSections(
  sections: DocSection[],
  claims: DocClaim[],
): DocSection[] {
  const sectionIds = new Set(claims.map((claim) => claim.sectionId));
  return sections.filter((section) => sectionIds.has(section.id));
}

async function collectCurrentRenderedHashes(
  notion: NotionPort,
  sections: DocSection[],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};

  for (const section of sections) {
    hashes[section.id] = await notion.getRenderedHash(section);
  }

  return hashes;
}

function workspaceFromImportRun(importRun: ImportRun): NotionWorkspace {
  if (
    !importRun.hubPageId ||
    !importRun.databases?.docSections ||
    !importRun.databases.docClaims ||
    !importRun.databases.mergedPrs ||
    !importRun.databases.docUpdateRuns ||
    !importRun.databases.reviewQueue
  ) {
    throw new Error("The import run does not have persisted Notion workspace links.");
  }

  return {
    hubPageId: importRun.hubPageId,
    hubUrl: importRun.hubUrl,
    databases: {
      docSections: importRun.databases.docSections,
      docClaims: importRun.databases.docClaims,
      mergedPrs: importRun.databases.mergedPrs,
      docUpdateRuns: importRun.databases.docUpdateRuns,
      reviewQueue: importRun.databases.reviewQueue,
    },
  };
}
