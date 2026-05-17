import { randomUUID } from "node:crypto";
import type { DocClaim, DocSection, MergedPrEvent, RepoSource } from "./schemas";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "ignored";

export type NotionDatabaseLinks = {
  docSections?: string;
  docClaims?: string;
  mergedPrs?: string;
  docUpdateRuns?: string;
  reviewQueue?: string;
};

export type ImportRun = {
  id: string;
  status: RunStatus;
  githubUrl: string;
  createdAt: string;
  updatedAt: string;
  logs: string[];
  repo?: RepoSource;
  hubPageId?: string;
  hubUrl?: string;
  databases?: NotionDatabaseLinks;
  sections: DocSection[];
  claims: DocClaim[];
  error?: string;
};

export type ReviewTask = {
  id: string;
  title: string;
  reason: string;
  unresolvedQuestion: string;
  prUrl?: string;
  changedFiles: string[];
  affectedClaimIds: string[];
  evidenceRefs: string[];
  notionPageUrl?: string;
};

export type DocUpdateRun = {
  id: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  importRunId?: string;
  event?: MergedPrEvent;
  impactedClaimIds: string[];
  changedFiles: string[];
  appliedSectionIds: string[];
  reviewTasks: ReviewTask[];
  logs: string[];
  error?: string;
};

type StoreShape = {
  imports: Map<string, ImportRun>;
  updates: Map<string, DocUpdateRun>;
  latestImportRunId?: string;
};

const globalStore = globalThis as typeof globalThis & {
  __nbrainStore?: StoreShape;
};

const store =
  globalStore.__nbrainStore ??
  (globalStore.__nbrainStore = {
    imports: new Map<string, ImportRun>(),
    updates: new Map<string, DocUpdateRun>(),
  });

export function createImportRun(githubUrl: string): ImportRun {
  const now = new Date().toISOString();
  const run: ImportRun = {
    id: randomUUID(),
    status: "queued",
    githubUrl,
    createdAt: now,
    updatedAt: now,
    logs: ["Queued repository import."],
    sections: [],
    claims: [],
  };

  store.imports.set(run.id, run);
  store.latestImportRunId = run.id;
  return run;
}

export function updateImportRun(
  runId: string,
  update: Partial<Omit<ImportRun, "id" | "createdAt">> & { log?: string },
): ImportRun {
  const current = getImportRun(runId);

  if (!current) {
    throw new Error(`Import run ${runId} does not exist.`);
  }

  const logs = update.log ? [...current.logs, update.log] : update.logs ?? current.logs;
  const next: ImportRun = {
    ...current,
    ...update,
    logs,
    updatedAt: new Date().toISOString(),
  };

  delete (next as { log?: string }).log;
  store.imports.set(runId, next);
  return next;
}

export function getImportRun(runId: string): ImportRun | undefined {
  return store.imports.get(runId);
}

export function getLatestImportRun(): ImportRun | undefined {
  return store.latestImportRunId ? getImportRun(store.latestImportRunId) : undefined;
}

export function createDocUpdateRun(importRunId?: string): DocUpdateRun {
  const now = new Date().toISOString();
  const run: DocUpdateRun = {
    id: randomUUID(),
    status: "queued",
    createdAt: now,
    updatedAt: now,
    importRunId,
    impactedClaimIds: [],
    changedFiles: [],
    appliedSectionIds: [],
    reviewTasks: [],
    logs: ["Queued merged PR update."],
  };

  store.updates.set(run.id, run);
  return run;
}

export function updateDocUpdateRun(
  runId: string,
  update: Partial<Omit<DocUpdateRun, "id" | "createdAt">> & { log?: string },
): DocUpdateRun {
  const current = getDocUpdateRun(runId);

  if (!current) {
    throw new Error(`Doc update run ${runId} does not exist.`);
  }

  const logs = update.log ? [...current.logs, update.log] : update.logs ?? current.logs;
  const next: DocUpdateRun = {
    ...current,
    ...update,
    logs,
    updatedAt: new Date().toISOString(),
  };

  delete (next as { log?: string }).log;
  store.updates.set(runId, next);
  return next;
}

export function getDocUpdateRun(runId: string): DocUpdateRun | undefined {
  return store.updates.get(runId);
}

export function listDocUpdateRuns(): DocUpdateRun[] {
  return [...store.updates.values()].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

export function replaceImportRunSection(section: DocSection): void {
  for (const run of store.imports.values()) {
    const index = run.sections.findIndex((candidate) => candidate.id === section.id);

    if (index >= 0) {
      const sections = [...run.sections];
      sections[index] = section;
      updateImportRun(run.id, { sections });
      return;
    }
  }
}

export function replaceImportRunClaim(claim: DocClaim): void {
  for (const run of store.imports.values()) {
    const index = run.claims.findIndex((candidate) => candidate.id === claim.id);

    if (index >= 0) {
      const claims = [...run.claims];
      claims[index] = claim;
      updateImportRun(run.id, { claims });
      return;
    }
  }
}
