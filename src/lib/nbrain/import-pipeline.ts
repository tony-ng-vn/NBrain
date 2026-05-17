import { randomUUID } from "node:crypto";
import { fallbackClaimsFromMarkdown } from "./claims";
import { readDeepWikiRepoGuide, type DeepWikiSection } from "./deepwiki";
import { fetchRepoSource } from "./github-api";
import { parseGitHubRepoUrl } from "./github";
import { notionRenderedHash, stableHash } from "./hash";
import { createNotionAdapter, type NotionPort, type NotionWorkspace } from "./notion";
import { extractClaimsForSection } from "./openai";
import {
  getImportRun,
  updateImportRun,
  type ImportRun,
} from "./run-store";
import type { DocClaim, DocSection } from "./schemas";

export type ImportPipelineInput = {
  githubUrl: string;
  notionParentPageId?: string;
};

export type ImportPipelineDeps = {
  notion?: NotionPort;
  readDeepWiki?: (repoFullName: string) => Promise<DeepWikiSection[]>;
  extractClaims?: (args: { sectionId: string; markdown: string }) => Promise<DocClaim[]>;
};

export async function runImportPipeline(
  runId: string,
  input: ImportPipelineInput,
  deps: ImportPipelineDeps = {},
): Promise<ImportRun> {
  const run = getImportRun(runId);

  if (!run) {
    throw new Error(`Import run ${runId} does not exist.`);
  }

  const notionParentPageId = input.notionParentPageId ?? process.env.NOTION_PARENT_PAGE_ID;

  if (!notionParentPageId) {
    updateImportRun(runId, {
      status: "failed",
      error: "NOTION_PARENT_PAGE_ID is required.",
      log: "Import failed before Notion setup because no parent page id was configured.",
    });
    return getImportRun(runId)!;
  }

  try {
    updateImportRun(runId, { status: "running", log: "Parsed GitHub repository URL." });
    const parsedRepo = parseGitHubRepoUrl(input.githubUrl);
    const repoSource = await fetchRepoSource(parsedRepo);
    updateImportRun(runId, {
      repo: repoSource,
      log: `Resolved ${parsedRepo.fullName} with default branch ${repoSource.defaultBranch}.`,
    });

    const readDeepWiki = deps.readDeepWiki ?? readDeepWikiRepoGuide;
    const deepWikiSections = await readDeepWiki(parsedRepo.fullName);
    updateImportRun(runId, {
      log: `Imported ${deepWikiSections.length} DeepWiki section(s).`,
    });

    const notion = deps.notion ?? createNotionAdapter();
    const workspace = await notion.createWorkspace({
      parentPageId: notionParentPageId,
      repoFullName: parsedRepo.fullName,
      githubUrl: parsedRepo.githubUrl,
    });

    updateImportRun(runId, {
      hubPageId: workspace.hubPageId,
      hubUrl: workspace.hubUrl,
      databases: workspace.databases,
      repo: {
        ...repoSource,
        hubPageId: workspace.hubPageId,
        latestImportRunId: runId,
      },
      log: "Created Notion hub and visible demo databases.",
    });

    const { sections, claims } = await createManagedSections({
      repoFullName: parsedRepo.fullName,
      workspace,
      deepWikiSections,
      notion,
      extractClaims: deps.extractClaims ?? extractClaimsForSection,
    });

    await notion.persistSectionsAndClaims({ workspace, sections, claims });

    updateImportRun(runId, {
      status: "completed",
      sections,
      claims,
      log: `Persisted ${sections.length} Repo Guide section(s) and ${claims.length} claim(s).`,
    });

    return getImportRun(runId)!;
  } catch (error) {
    updateImportRun(runId, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown import failure.",
      log: "Import failed.",
    });
    return getImportRun(runId)!;
  }
}

async function createManagedSections(args: {
  repoFullName: string;
  workspace: NotionWorkspace;
  deepWikiSections: DeepWikiSection[];
  notion: NotionPort;
  extractClaims: (input: { sectionId: string; markdown: string }) => Promise<DocClaim[]>;
}): Promise<{ sections: DocSection[]; claims: DocClaim[] }> {
  const sections: DocSection[] = [];
  const claims: DocClaim[] = [];

  for (const [index, deepWikiSection] of args.deepWikiSections.slice(0, 5).entries()) {
    const sectionId = `section_${index + 1}_${randomUUID()}`;
    const renderedMarkdown = renderManagedSection(deepWikiSection);
    const sectionPage = await args.notion.createSectionPage({
      hubPageId: args.workspace.hubPageId,
      title: deepWikiSection.title,
      markdown: renderedMarkdown,
    });
    const extractedClaims = await args.extractClaims({
      sectionId,
      markdown: deepWikiSection.markdown,
    });
    const sectionClaims =
      extractedClaims.length > 0
        ? extractedClaims.map((claim) => ({ ...claim, sectionId }))
        : fallbackClaimsFromMarkdown(sectionId, deepWikiSection.markdown);

    claims.push(...sectionClaims);
    sections.push({
      id: sectionId,
      repoFullName: args.repoFullName,
      title: deepWikiSection.title,
      sourceMarkdown: deepWikiSection.markdown,
      sourceMarkdownHash: stableHash(deepWikiSection.markdown),
      renderedMarkdown,
      renderedNotionHash: notionRenderedHash(renderedMarkdown),
      claimIds: sectionClaims.map((claim) => claim.id),
      notionPageId: sectionPage.pageId,
      notionUrl: sectionPage.url,
      sourceSnapshot: deepWikiSection.sourceSnapshot,
    });
  }

  return { sections, claims };
}

function renderManagedSection(section: DeepWikiSection): string {
  return [
    section.markdown.trim(),
    "",
    "---",
    "",
    "Managed by NBrain. If this page is manually edited, NBrain will create a Review Queue task before overwriting it.",
  ].join("\n");
}
