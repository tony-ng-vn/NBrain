import type { DocUpdateRun, ImportRun } from "./run-store";

export function serializeImportRun(run: ImportRun) {
  return {
    id: run.id,
    status: run.status,
    githubUrl: run.githubUrl,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    logs: run.logs,
    error: run.error,
    repo: run.repo,
    hubPageId: run.hubPageId,
    hubUrl: run.hubUrl,
    databases: run.databases,
    sections: run.sections.map((section) => ({
      id: section.id,
      title: section.title,
      repoFullName: section.repoFullName,
      sourceMarkdownHash: section.sourceMarkdownHash,
      renderedNotionHash: section.renderedNotionHash,
      claimIds: section.claimIds,
      notionPageId: section.notionPageId,
      notionUrl: section.notionUrl,
    })),
    claims: run.claims.map((claim) => ({
      id: claim.id,
      sectionId: claim.sectionId,
      text: claim.text,
      kind: claim.kind,
      coveredPaths: claim.coveredPaths,
      concepts: claim.concepts,
      evidenceRefs: claim.evidenceRefs,
      confidence: claim.confidence,
      staleStatus: claim.staleStatus,
    })),
  };
}

export function serializeDocUpdateRun(run: DocUpdateRun) {
  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    importRunId: run.importRunId,
    event: run.event,
    impactedClaimIds: run.impactedClaimIds,
    changedFiles: run.changedFiles,
    appliedSectionIds: run.appliedSectionIds,
    reviewTasks: run.reviewTasks,
    logs: run.logs,
    error: run.error,
  };
}
