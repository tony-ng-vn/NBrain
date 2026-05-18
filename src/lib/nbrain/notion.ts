import { randomUUID } from "node:crypto";
import { Client } from "@notionhq/client";
import { notionRenderedHash, stableHash } from "./hash";
import type { DocClaim, DocSection, MergedPrEvent } from "./schemas";
import type { DocUpdateRun, NotionDatabaseLinks, ReviewTask } from "./run-store";

export type RequiredNotionDatabaseLinks = {
  docSections: string;
  docClaims: string;
  mergedPrs: string;
  docUpdateRuns: string;
  reviewQueue: string;
};

export type NotionWorkspace = {
  hubPageId: string;
  hubUrl?: string;
  repoPageId?: string;
  databases: RequiredNotionDatabaseLinks;
};

export type CreateReviewTaskInput = {
  title: string;
  reason: string;
  unresolvedQuestion: string;
  prUrl?: string;
  changedFiles: string[];
  affectedClaimIds: string[];
  evidenceRefs: string[];
};

export type NotionPort = {
  createWorkspace(args: {
    parentPageId: string;
    repoFullName: string;
    githubUrl: string;
    defaultBranch?: string;
    importRunId?: string;
  }): Promise<NotionWorkspace>;
  createSectionPage(args: {
    hubPageId: string;
    title: string;
    markdown: string;
  }): Promise<{ pageId: string; url?: string }>;
  persistSectionsAndClaims(args: {
    workspace: NotionWorkspace;
    sections: DocSection[];
    claims: DocClaim[];
  }): Promise<void>;
  recordMergedPr(args: {
    workspace: NotionWorkspace;
    event: MergedPrEvent;
  }): Promise<void>;
  recordDocUpdateRun(args: {
    workspace: NotionWorkspace;
    run: DocUpdateRun;
  }): Promise<void>;
  createReviewTask(args: {
    workspace: NotionWorkspace;
    task: CreateReviewTaskInput;
  }): Promise<ReviewTask>;
  getRenderedHash(section: DocSection): Promise<string>;
  replaceSectionContent(section: DocSection, markdown: string): Promise<string>;
};

let notionClient: Client | undefined;
const dataSourceIdCache = new Map<string, string>();

const DATABASE_ENV = {
  docSections: "NBRAIN_DOC_SECTIONS_DATABASE_ID",
  docClaims: "NBRAIN_DOC_CLAIMS_DATABASE_ID",
  mergedPrs: "NBRAIN_MERGED_PRS_DATABASE_ID",
  docUpdateRuns: "NBRAIN_DOC_UPDATE_RUNS_DATABASE_ID",
  reviewQueue: "NBRAIN_REVIEW_QUEUE_DATABASE_ID",
} as const;
const DEFAULT_REPO_SOURCES_DATABASE_ID = "84a06a2583a4445aba3fe09824a5f2a4";

export function getNotionClient(): Client {
  const token = process.env.NOTION_TOKEN;

  if (!token) {
    throw new Error("NOTION_TOKEN is required for live Notion writes.");
  }

  notionClient ??= new Client({
    auth: token,
    timeoutMs: 120_000,
    retry: {
      maxRetries: 4,
      initialRetryDelayMs: 1_000,
      maxRetryDelayMs: 15_000,
    },
  });
  return notionClient;
}

export function createNotionAdapter(): NotionPort {
  return {
    async createWorkspace({ parentPageId, repoFullName, githubUrl, defaultBranch, importRunId }) {
      const notion = getNotionClient();
      const configuredDatabases = configuredDatabaseLinks();
      if (configuredDatabases) {
        await ensureNBrainDataSourceProperties(notion, configuredDatabases);
      }
      const repoSource = configuredDatabases
        ? await upsertRepoSourcePage(notion, {
            parentPageId,
            repoFullName,
            githubUrl,
            defaultBranch,
            importRunId,
          })
        : null;
      const hub =
        repoSource ??
        (await notion.pages.create({
          parent: { page_id: normalizeNotionId(parentPageId) },
          properties: {
            title: titleProperty(`${repoFullName} Repo Knowledge Hub`),
          },
          children: markdownToBlocks(repoHubMarkdown(repoFullName, githubUrl)),
        } as unknown as Parameters<typeof notion.pages.create>[0]));

      const hubPageId = hub.id;
      const hubUrl = "url" in hub ? hub.url : undefined;

      const databases = configuredDatabases ?? {
        docSections: await createDatabase(notion, hubPageId, "Doc Sections", {
          Name: { title: {} },
          "Repo Key": { rich_text: {} },
          Repo: { rich_text: {} },
          "Section ID": { rich_text: {} },
          "Notion Page": { url: {} },
          "Source Markdown Hash": { rich_text: {} },
          "Rendered Notion Hash": { rich_text: {} },
          "Claim IDs": { rich_text: {} },
          Status: { select: {} },
          "Last Updated By": { select: {} },
        }),
        docClaims: await createDatabase(notion, hubPageId, "Doc Claims", {
          Claim: { title: {} },
          "Claim ID": { rich_text: {} },
          "Repo Key": { rich_text: {} },
          Kind: { select: {} },
          Status: { select: {} },
          "Section ID": { rich_text: {} },
          "Covered Paths": { rich_text: {} },
          Concepts: { rich_text: {} },
          "Evidence Refs": { rich_text: {} },
          Confidence: { number: { format: "percent" } },
        }),
        mergedPrs: await createDatabase(notion, hubPageId, "Merged PRs", {
          Name: { title: {} },
          Repo: { rich_text: {} },
          "PR Number": { number: {} },
          "PR URL": { url: {} },
          "Base Branch": { rich_text: {} },
          "Merge Commit": { rich_text: {} },
          "Changed Files": { rich_text: {} },
          Status: { select: {} },
          "Impacted Claim IDs": { rich_text: {} },
          "Impacted Section IDs": { rich_text: {} },
          "Agent Summary": { rich_text: {} },
          Error: { rich_text: {} },
        }),
        docUpdateRuns: await createDatabase(notion, hubPageId, "Doc Update Runs", {
          Name: { title: {} },
          "Run ID": { rich_text: {} },
          Status: { select: {} },
          "PR Number": { number: {} },
          "Proposed Operations": { rich_text: {} },
          "Applied Section IDs": { rich_text: {} },
          "Review Task IDs": { rich_text: {} },
          Logs: { rich_text: {} },
        }),
        reviewQueue: await createDatabase(notion, hubPageId, "Review Queue", {
          Title: { title: {} },
          Status: { select: {} },
          Reason: { rich_text: {} },
          "Unresolved Question": { rich_text: {} },
          "PR URL": { url: {} },
          "Changed Files": { rich_text: {} },
          "Affected Claim IDs": { rich_text: {} },
          "Evidence Refs": { rich_text: {} },
          "Suggested Next Step": { rich_text: {} },
        }),
      };

      return {
        hubPageId,
        hubUrl,
        repoPageId: repoSource?.id,
        databases,
      };
    },

    async createSectionPage({ hubPageId, title, markdown }) {
      const notion = getNotionClient();
      const blocks = markdownToBlocks(markdown);
      const page = await notion.pages.create({
        parent: { page_id: hubPageId },
        properties: {
          title: titleProperty(title),
        },
        children: blocks.slice(0, 100),
      } as unknown as Parameters<typeof notion.pages.create>[0]);

      if (blocks.length > 100) {
        await appendBlocksInBatches(notion, page.id, blocks.slice(100));
      }

      return {
        pageId: page.id,
        url: "url" in page ? page.url : undefined,
      };
    },

    async persistSectionsAndClaims({ workspace, sections, claims }) {
      const notion = getNotionClient();
      const repoFullName = sections[0]?.repoFullName;

      if (repoFullName) {
        await archivePreviousRepoGraph(notion, workspace.databases, repoFullName);
      }

      for (const section of sections) {
        await notion.pages.create({
          parent: { data_source_id: await dataSourceId(notion, workspace.databases.docSections) },
          properties: {
            Name: titleProperty(section.title),
            ...(workspace.repoPageId ? { Repo: relationProperty(workspace.repoPageId) } : {}),
            "Repo Key": richTextProperty(section.repoFullName),
            "Section ID": richTextProperty(section.id),
            "Notion Page": urlProperty(section.notionUrl),
            "Source Markdown Hash": richTextProperty(section.sourceMarkdownHash),
            "Rendered Notion Hash": richTextProperty(section.renderedNotionHash),
            "Claim IDs": richTextProperty(section.claimIds.join(", ")),
            Status: selectProperty("Managed"),
            "Last Updated By": selectProperty("NBrain"),
          },
        } as unknown as Parameters<typeof notion.pages.create>[0]);
      }

      for (const claim of claims) {
        await notion.pages.create({
          parent: { data_source_id: await dataSourceId(notion, workspace.databases.docClaims) },
          properties: {
            Claim: titleProperty(claim.text),
            "Claim ID": richTextProperty(claim.id),
            "Repo Key": richTextProperty(sections.find((section) => section.id === claim.sectionId)?.repoFullName ?? ""),
            Kind: selectProperty(claim.kind),
            Status: selectProperty(claim.staleStatus),
            "Section ID": richTextProperty(claim.sectionId),
            "Covered Paths": richTextProperty(claim.coveredPaths.join("\n")),
            Concepts: richTextProperty(claim.concepts.join(", ")),
            "Evidence Refs": richTextProperty(claim.evidenceRefs.join("\n")),
            Confidence: { number: claim.confidence },
          },
        } as unknown as Parameters<typeof notion.pages.create>[0]);
      }
    },

    async recordMergedPr({ workspace, event }) {
      const notion = getNotionClient();
      await notion.pages.create({
        parent: { data_source_id: await dataSourceId(notion, workspace.databases.mergedPrs) },
        properties: {
          Name: titleProperty(`PR #${event.number}: ${event.title}`),
          ...(workspace.repoPageId ? { Repo: relationProperty(workspace.repoPageId) } : {}),
          "PR Number": { number: event.number },
          "PR URL": urlProperty(event.htmlUrl),
          "Base Branch": richTextProperty(event.baseBranch),
          "Merge Commit": richTextProperty(event.mergeCommitSha ?? ""),
          "Changed Files": richTextProperty(event.changedFiles.join("\n")),
          Status: selectProperty("Recorded"),
        },
      } as unknown as Parameters<typeof notion.pages.create>[0]);
    },

    async recordDocUpdateRun({ workspace, run }) {
      const notion = getNotionClient();
      await notion.pages.create({
        parent: { data_source_id: await dataSourceId(notion, workspace.databases.docUpdateRuns) },
        properties: {
          Name: titleProperty(`Doc update ${run.id.slice(0, 8)}`),
          "Run ID": richTextProperty(run.id),
          Status: selectProperty(run.status),
          "PR Number": run.event ? { number: run.event.number } : undefined,
          "Proposed Operations": richTextProperty(""),
          "Applied Section IDs": richTextProperty(run.appliedSectionIds.join(", ")),
          "Review Task IDs": richTextProperty(run.reviewTasks.map((task) => task.id).join(", ")),
          Logs: richTextProperty(run.logs.join("\n")),
        },
      } as unknown as Parameters<typeof notion.pages.create>[0]);
    },

    async createReviewTask({ workspace, task }) {
      const notion = getNotionClient();
      const page = await notion.pages.create({
        parent: { data_source_id: await dataSourceId(notion, workspace.databases.reviewQueue) },
        properties: {
          Title: titleProperty(task.title),
          Status: selectProperty("Open"),
          Reason: richTextProperty(task.reason),
          "Unresolved Question": richTextProperty(task.unresolvedQuestion),
          "PR URL": urlProperty(task.prUrl),
          "Changed Files": richTextProperty(task.changedFiles.join("\n")),
          "Affected Claim IDs": richTextProperty(task.affectedClaimIds.join(", ")),
          "Evidence Refs": richTextProperty(task.evidenceRefs.join("\n")),
          "Suggested Next Step": richTextProperty("Inspect the PR and update the Repo Guide manually if needed."),
        },
      } as unknown as Parameters<typeof notion.pages.create>[0]);

      return {
        id: randomUUID(),
        title: task.title,
        reason: task.reason,
        unresolvedQuestion: task.unresolvedQuestion,
        prUrl: task.prUrl,
        changedFiles: task.changedFiles,
        affectedClaimIds: task.affectedClaimIds,
        evidenceRefs: task.evidenceRefs,
        notionPageUrl: "url" in page ? page.url : undefined,
      };
    },

    async getRenderedHash(section) {
      if (!section.notionPageId) {
        return section.renderedNotionHash;
      }

      const notion = getNotionClient();
      const blocks = await listAllChildBlocks(notion, section.notionPageId);
      const text = blocks.map(extractPlainText).filter(Boolean).join("\n");
      return stableHash(text);
    },

    async replaceSectionContent(section, markdown) {
      if (!section.notionPageId) {
        return notionRenderedHash(markdown);
      }

      const notion = getNotionClient();
      const blocks = await listAllChildBlocks(notion, section.notionPageId);

      for (const block of blocks) {
        if (typeof block.id === "string") {
          await notion.blocks.delete({ block_id: block.id });
        }
      }

      await appendBlocksInBatches(notion, section.notionPageId, markdownToBlocks(markdown));

      return notionRenderedHash(markdown);
    },
  };
}

async function appendBlocksInBatches(
  notion: Client,
  blockId: string,
  blocks: Array<Record<string, unknown>>,
): Promise<void> {
  for (let index = 0; index < blocks.length; index += 100) {
    await notion.blocks.children.append({
      block_id: blockId,
      children: blocks.slice(index, index + 100),
    } as unknown as Parameters<typeof notion.blocks.children.append>[0]);
  }
}

async function listAllChildBlocks(notion: Client, blockId: string): Promise<Array<Record<string, unknown>>> {
  const blocks: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;

  do {
    const response = (await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor: cursor,
    } as unknown as Parameters<typeof notion.blocks.children.list>[0])) as {
      results: Array<Record<string, unknown>>;
      next_cursor?: string | null;
    };

    blocks.push(...response.results);
    cursor = response.next_cursor ?? undefined;
  } while (cursor);

  return blocks;
}

function configuredDatabaseLinks(): RequiredNotionDatabaseLinks | null {
  const links = Object.fromEntries(
    Object.entries(DATABASE_ENV).map(([key, envKey]) => [key, process.env[envKey]]),
  ) as Record<keyof RequiredNotionDatabaseLinks, string | undefined>;

  if (
    !links.docSections ||
    !links.docClaims ||
    !links.mergedPrs ||
    !links.docUpdateRuns ||
    !links.reviewQueue
  ) {
    return null;
  }

  return {
    docSections: normalizeNotionId(links.docSections),
    docClaims: normalizeNotionId(links.docClaims),
    mergedPrs: normalizeNotionId(links.mergedPrs),
    docUpdateRuns: normalizeNotionId(links.docUpdateRuns),
    reviewQueue: normalizeNotionId(links.reviewQueue),
  };
}

function repoSourcesDatabaseId(): string | null {
  return normalizeNotionId(process.env.NBRAIN_REPO_SOURCES_DATABASE_ID ?? DEFAULT_REPO_SOURCES_DATABASE_ID);
}

async function dataSourceId(notion: Client, databaseId: string): Promise<string> {
  const normalizedDatabaseId = normalizeNotionId(databaseId);
  const cached = dataSourceIdCache.get(normalizedDatabaseId);
  if (cached) return cached;

  const database = (await notion.databases.retrieve({
    database_id: normalizedDatabaseId,
  } as unknown as Parameters<typeof notion.databases.retrieve>[0])) as Record<string, unknown>;
  const sources = Array.isArray(database.data_sources) ? database.data_sources : [];
  const firstSource = sources[0] as Record<string, unknown> | undefined;
  const id = typeof firstSource?.id === "string" ? firstSource.id : "";

  if (!id) {
    throw new Error(`No data source found for Notion database ${normalizedDatabaseId}.`);
  }

  dataSourceIdCache.set(normalizedDatabaseId, id);
  return id;
}

async function ensureNBrainDataSourceProperties(
  notion: Client,
  databases: RequiredNotionDatabaseLinks,
): Promise<void> {
  await Promise.all([
    ensureRichTextProperty(notion, databases.docSections, "Repo Key"),
    ensureRichTextProperty(notion, databases.docClaims, "Repo Key"),
  ]);
}

async function archivePreviousRepoGraph(
  notion: Client,
  databases: RequiredNotionDatabaseLinks,
  repoFullName: string,
): Promise<void> {
  await archivePagesForRepo(notion, databases.docClaims, repoFullName);
  await archivePagesForRepo(notion, databases.docSections, repoFullName, async (page) => {
    const sectionPageUrl = propertyUrl(page, "Notion Page");
    const sectionPageId = sectionPageUrl ? normalizeNotionId(sectionPageUrl) : "";
    if (!sectionPageId) {
      return;
    }

    try {
      await notion.pages.update({
        page_id: sectionPageId,
        archived: true,
      } as unknown as Parameters<typeof notion.pages.update>[0]);
    } catch {
      // The managed section page may already be deleted or inaccessible. Archiving
      // the index row is still enough to keep future worker matches scoped.
    }
  });
}

async function archivePagesForRepo(
  notion: Client,
  databaseId: string,
  repoFullName: string,
  beforeArchive?: (page: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const sourceId = await dataSourceId(notion, databaseId);
  let cursor: string | undefined;

  do {
    const response = (await notion.dataSources.query({
      data_source_id: sourceId,
      filter: { property: "Repo Key", rich_text: { equals: repoFullName } },
      start_cursor: cursor,
      page_size: 100,
    } as unknown as Parameters<typeof notion.dataSources.query>[0])) as {
      results: Array<Record<string, unknown>>;
      next_cursor?: string | null;
    };

    for (const page of response.results) {
      if (page.archived === true || page.in_trash === true || typeof page.id !== "string") {
        continue;
      }

      await beforeArchive?.(page);
      await notion.pages.update({
        page_id: page.id,
        archived: true,
      } as unknown as Parameters<typeof notion.pages.update>[0]);
    }

    cursor = response.next_cursor ?? undefined;
  } while (cursor);
}

async function upsertRepoSourcePage(
  notion: Client,
  input: {
    parentPageId: string;
    repoFullName: string;
    githubUrl: string;
    defaultBranch?: string;
    importRunId?: string;
  },
): Promise<CreatePageResponseLike> {
  const databaseId = repoSourcesDatabaseId();
  if (!databaseId) {
    return createHubPage(notion, input.parentPageId, input.repoFullName, input.githubUrl);
  }

  const schema = await ensureRepoSourceDataSourceProperties(notion, databaseId);
  const existing = await findRepoSourcePage(notion, schema, input.repoFullName, input.githubUrl);
  const properties = repoSourceProperties(input, schema);

  if (existing) {
    const page = await notion.pages.update({
      page_id: existing.id,
      properties,
    } as unknown as Parameters<typeof notion.pages.update>[0]);
    await updateRepoSourceHubPage(notion, page as CreatePageResponseLike, schema);
    await ensureHubIntroBlocks(notion, String(existing.id), input.repoFullName, input.githubUrl);
    return page as CreatePageResponseLike;
  }

  const page = (await notion.pages.create({
    parent: { data_source_id: schema.sourceId },
    properties,
    children: markdownToBlocks(repoHubMarkdown(input.repoFullName, input.githubUrl)),
  } as unknown as Parameters<typeof notion.pages.create>[0])) as CreatePageResponseLike;
  await updateRepoSourceHubPage(notion, page, schema);
  return page;
}

type CreatePageResponseLike = {
  id: string;
  url?: string;
};

type RepoSourceDataSourceSchema = {
  sourceId: string;
  titleProperty: string;
  githubUrlProperty: string;
  hubPageProperty: string;
};

async function ensureRepoSourceDataSourceProperties(
  notion: Client,
  databaseId: string,
): Promise<RepoSourceDataSourceSchema> {
  const sourceId = await dataSourceId(notion, databaseId);
  const source = (await notion.dataSources.retrieve({
    data_source_id: sourceId,
  } as unknown as Parameters<typeof notion.dataSources.retrieve>[0])) as Record<string, unknown>;
  const properties = (source.properties as Record<string, { type?: string }> | undefined) ?? {};
  const titleProperty = propertyNameForType(properties, "title") ?? "Name";
  const githubUrlProperty =
    (properties["GitHub URL"]?.type === "url" && "GitHub URL") ||
    (properties["GitHub Repo"]?.type === "url" && "GitHub Repo") ||
    "GitHub URL";
  const hubPageProperty = "Hub Page";
  const missingProperties: Record<string, unknown> = {};

  if (!properties[githubUrlProperty]) {
    missingProperties[githubUrlProperty] = { type: "url", url: {} };
  }
  for (const property of ["Repo", "Owner", "Default Branch", "Latest Import Run", "Notes"]) {
    if (!properties[property]) {
      missingProperties[property] = { type: "rich_text", rich_text: {} };
    }
  }
  if (!properties.Status) {
    missingProperties.Status = { type: "select", select: {} };
  }
  if (!properties[hubPageProperty]) {
    missingProperties[hubPageProperty] = { type: "url", url: {} };
  }

  if (Object.keys(missingProperties).length > 0) {
    await notion.dataSources.update({
      data_source_id: sourceId,
      properties: missingProperties,
    } as unknown as Parameters<typeof notion.dataSources.update>[0]);
  }

  return {
    sourceId,
    titleProperty,
    githubUrlProperty,
    hubPageProperty,
  };
}

async function createHubPage(
  notion: Client,
  parentPageId: string,
  repoFullName: string,
  githubUrl: string,
): Promise<CreatePageResponseLike> {
  return (await notion.pages.create({
    parent: { page_id: normalizeNotionId(parentPageId) },
    properties: {
      title: titleProperty(`${repoFullName} Repo Knowledge Hub`),
    },
    children: markdownToBlocks(repoHubMarkdown(repoFullName, githubUrl)),
  } as unknown as Parameters<typeof notion.pages.create>[0])) as CreatePageResponseLike;
}

async function findRepoSourcePage(
  notion: Client,
  schema: RepoSourceDataSourceSchema,
  repoFullName: string,
  githubUrl: string,
): Promise<Record<string, unknown> | null> {
  const response = (await notion.dataSources.query({
    data_source_id: schema.sourceId,
    filter: {
      or: [
        { property: "Repo", rich_text: { equals: repoFullName } },
        { property: schema.githubUrlProperty, url: { equals: githubUrl } },
      ],
    },
    page_size: 1,
  } as unknown as Parameters<typeof notion.dataSources.query>[0])) as { results: Array<Record<string, unknown>> };

  return response.results.find((page) => !page.archived && !page.in_trash) ?? null;
}

async function ensureHubIntroBlocks(
  notion: Client,
  pageId: string,
  repoFullName: string,
  githubUrl: string,
): Promise<void> {
  const children = await notion.blocks.children.list({
    block_id: pageId,
    page_size: 10,
  });

  if (children.results.length > 0) {
    return;
  }

  await notion.blocks.children.append({
    block_id: pageId,
    children: markdownToBlocks(repoHubMarkdown(repoFullName, githubUrl)),
  } as unknown as Parameters<typeof notion.blocks.children.append>[0]);
}

async function updateRepoSourceHubPage(
  notion: Client,
  page: CreatePageResponseLike,
  schema: RepoSourceDataSourceSchema,
): Promise<void> {
  if (!page.url) {
    return;
  }

  await notion.pages.update({
    page_id: page.id,
    properties: {
      [schema.hubPageProperty]: urlProperty(page.url),
    },
  } as unknown as Parameters<typeof notion.pages.update>[0]);
}

function repoSourceProperties(input: {
  repoFullName: string;
  githubUrl: string;
  defaultBranch?: string;
  importRunId?: string;
}, schema: RepoSourceDataSourceSchema) {
  const [owner] = input.repoFullName.split("/");
  return {
    [schema.titleProperty]: titleProperty(input.repoFullName),
    Repo: richTextProperty(input.repoFullName),
    Owner: richTextProperty(owner ?? ""),
    [schema.githubUrlProperty]: urlProperty(input.githubUrl),
    "Default Branch": richTextProperty(input.defaultBranch ?? ""),
    "Latest Import Run": richTextProperty(input.importRunId ?? ""),
    Status: selectProperty("Imported"),
    Notes: richTextProperty("Managed by NBrain."),
  };
}

function repoHubMarkdown(repoFullName: string, githubUrl: string): string {
  return [
    `# ${repoFullName} Repo Guide`,
    "",
    `GitHub: ${githubUrl}`,
    "",
    "NBrain manages the linked Repo Guide pages, Claims & Evidence, and Review Queue for this prototype.",
  ].join("\n");
}

async function ensureRichTextProperty(
  notion: Client,
  databaseId: string,
  propertyName: string,
): Promise<void> {
  const sourceId = await dataSourceId(notion, databaseId);
  const source = (await notion.dataSources.retrieve({
    data_source_id: sourceId,
  } as unknown as Parameters<typeof notion.dataSources.retrieve>[0])) as Record<string, unknown>;
  const properties = source.properties as Record<string, unknown> | undefined;

  if (properties?.[propertyName]) {
    return;
  }

  await notion.dataSources.update({
    data_source_id: sourceId,
    properties: {
      [propertyName]: { type: "rich_text", rich_text: {} },
    },
  } as unknown as Parameters<typeof notion.dataSources.update>[0]);
}

async function createDatabase(
  notion: Client,
  parentPageId: string,
  title: string,
  properties: Record<string, unknown>,
): Promise<string> {
  const database = await notion.databases.create({
    parent: { page_id: parentPageId },
    title: [{ type: "text", text: { content: title } }],
    properties,
  } as unknown as Parameters<typeof notion.databases.create>[0]);

  return database.id;
}

function normalizeNotionId(value: string): string {
  const match = value.match(/[0-9a-fA-F]{32}/);
  return match ? match[0] : value;
}

function titleProperty(content: string) {
  return {
    title: [{ type: "text", text: { content: truncate(content, 1900) } }],
  };
}

function richTextProperty(content: string) {
  return {
    rich_text: [{ type: "text", text: { content: truncate(content, 1900) } }],
  };
}

function selectProperty(name: string) {
  return { select: { name } };
}

function urlProperty(url: string | undefined) {
  return url ? { url } : { url: null };
}

function relationProperty(pageId: string) {
  return { relation: [{ id: pageId }] };
}

function propertyNameForType(
  properties: Record<string, { type?: string }>,
  type: string,
): string | undefined {
  return Object.entries(properties).find(([, property]) => property.type === type)?.[0];
}

function propertyUrl(page: Record<string, unknown>, propertyName: string): string | undefined {
  const properties = page.properties as Record<string, unknown> | undefined;
  const property = properties?.[propertyName] as Record<string, unknown> | undefined;
  return typeof property?.url === "string" ? property.url : undefined;
}

function markdownToBlocks(markdown: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const lines = markdown.split("\n").map((line) => line.trimEnd());
  let codeLines: string[] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith("```")) {
      if (codeLines) {
        blocks.push(codeBlock(codeLines.join("\n")));
        codeLines = null;
      } else {
        codeLines = [];
      }
      continue;
    }

    if (codeLines) {
      codeLines.push(rawLine);
      continue;
    }

    if (!line || line === "<details>" || line === "</details>" || line.startsWith("<summary>")) {
      continue;
    }

    if (/^-{3,}$/.test(line)) {
      blocks.push({ object: "block", type: "divider", divider: {} });
      continue;
    }

    if (line.startsWith("### ")) {
      blocks.push(headingBlock("heading_3", line.slice(4)));
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push(headingBlock("heading_2", line.slice(3)));
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push(headingBlock("heading_1", line.slice(2)));
      continue;
    }
    if (line.startsWith("- ")) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: text(line.slice(2)) },
      });
      continue;
    }

    const numbered = line.match(/^\d+\.\s+(.+)$/);
    if (numbered) {
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: text(numbered[1] ?? "") },
      });
      continue;
    }

    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: text(line) },
    });
  }

  if (codeLines) {
    blocks.push(codeBlock(codeLines.join("\n")));
  }

  return blocks.length > 0 ? blocks : [paragraphBlock("No generated documentation content was available.")];
}

function headingBlock(type: "heading_1" | "heading_2" | "heading_3", content: string) {
  return {
    object: "block",
    type,
    [type]: { rich_text: text(content) },
  };
}

function paragraphBlock(content: string) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: text(content) },
  };
}

function codeBlock(content: string) {
  return {
    object: "block",
    type: "code",
    code: {
      rich_text: text(content),
      language: "plain text",
    },
  };
}

function text(content: string) {
  return richTextFromMarkdown(truncate(stripMarkdownLinks(content), 1900));
}

function richTextFromMarkdown(content: string): Array<Record<string, unknown>> {
  const chunks: Array<Record<string, unknown>> = [];
  const pattern = /(\*\*([^*]+)\*\*)|(`([^`]+)`)/g;
  let cursor = 0;

  for (const match of content.matchAll(pattern)) {
    if (match.index === undefined) {
      continue;
    }

    if (match.index > cursor) {
      chunks.push(richTextChunk(content.slice(cursor, match.index)));
    }

    if (match[2]) {
      chunks.push(richTextChunk(match[2], { bold: true }));
    } else if (match[4]) {
      chunks.push(richTextChunk(match[4], { code: true }));
    }

    cursor = match.index + match[0].length;
  }

  if (cursor < content.length) {
    chunks.push(richTextChunk(content.slice(cursor)));
  }

  return chunks.filter((chunk) => ((chunk.text as Record<string, unknown>).content as string).length > 0);
}

function richTextChunk(content: string, annotations: Record<string, boolean> = {}) {
  return {
    type: "text",
    text: { content },
    annotations,
  };
}

function stripMarkdownLinks(content: string): string {
  return content.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

function truncate(content: string, length: number): string {
  return content.length > length ? `${content.slice(0, length - 3)}...` : content;
}

function markdownToPlainText(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.replace(/^#{1,6}\s+/, "").replace(/^-\s+/, ""))
    .join("\n")
    .trim();
}

function extractPlainText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const record = block as Record<string, unknown>;
  const type = record.type;

  if (typeof type !== "string") {
    return "";
  }

  const body = record[type];

  if (!body || typeof body !== "object") {
    return "";
  }

  const richText = (body as Record<string, unknown>).rich_text;

  if (!Array.isArray(richText)) {
    return "";
  }

  return richText
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const plainText = (item as Record<string, unknown>).plain_text;
      return typeof plainText === "string" ? plainText : "";
    })
    .join("");
}
