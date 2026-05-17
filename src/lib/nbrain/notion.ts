import { randomUUID } from "node:crypto";
import { Client } from "@notionhq/client";
import { stableHash } from "./hash";
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

export function getNotionClient(): Client {
  const token = process.env.NOTION_TOKEN;

  if (!token) {
    throw new Error("NOTION_TOKEN is required for live Notion writes.");
  }

  notionClient ??= new Client({ auth: token });
  return notionClient;
}

export function createNotionAdapter(): NotionPort {
  return {
    async createWorkspace({ parentPageId, repoFullName, githubUrl }) {
      const notion = getNotionClient();
      const hub = await notion.pages.create({
        parent: { page_id: parentPageId },
        properties: {
          title: titleProperty(`${repoFullName} Repo Knowledge Hub`),
        },
        children: markdownToBlocks(
          [
            `# ${repoFullName} Repo Guide`,
            "",
            `GitHub: ${githubUrl}`,
            "",
            "NBrain manages the linked Repo Guide pages, Claims & Evidence, and Review Queue for this prototype.",
          ].join("\n"),
        ),
      } as unknown as Parameters<typeof notion.pages.create>[0]);

      const hubPageId = hub.id;
      const hubUrl = "url" in hub ? hub.url : undefined;

      const databases = {
        docSections: await createDatabase(notion, hubPageId, "Doc Sections", {
          Name: { title: {} },
          Repo: { rich_text: {} },
          "Source Hash": { rich_text: {} },
          "Rendered Hash": { rich_text: {} },
          "Claim IDs": { rich_text: {} },
          "Section Page": { url: {} },
          "Section Page ID": { rich_text: {} },
          "Source Snapshot": { rich_text: {} },
        }),
        docClaims: await createDatabase(notion, hubPageId, "Doc Claims", {
          Claim: { title: {} },
          Kind: { select: {} },
          Status: { select: {} },
          "Section ID": { rich_text: {} },
          "Covered Paths": { rich_text: {} },
          Concepts: { rich_text: {} },
          Evidence: { rich_text: {} },
          Confidence: { number: { format: "percent" } },
        }),
        mergedPrs: await createDatabase(notion, hubPageId, "Merged PRs", {
          Title: { title: {} },
          "PR Number": { number: {} },
          URL: { url: {} },
          "Base Branch": { rich_text: {} },
          "Merge Commit": { rich_text: {} },
          "Changed Files": { rich_text: {} },
        }),
        docUpdateRuns: await createDatabase(notion, hubPageId, "Doc Update Runs", {
          Name: { title: {} },
          Status: { select: {} },
          "PR Number": { number: {} },
          Summary: { rich_text: {} },
          "Impacted Claims": { rich_text: {} },
        }),
        reviewQueue: await createDatabase(notion, hubPageId, "Review Queue", {
          Title: { title: {} },
          Status: { select: {} },
          Reason: { rich_text: {} },
          "PR URL": { url: {} },
          "Changed Files": { rich_text: {} },
          "Affected Claims": { rich_text: {} },
          Evidence: { rich_text: {} },
          Question: { rich_text: {} },
        }),
      };

      return {
        hubPageId,
        hubUrl,
        databases,
      };
    },

    async createSectionPage({ hubPageId, title, markdown }) {
      const notion = getNotionClient();
      const page = await notion.pages.create({
        parent: { page_id: hubPageId },
        properties: {
          title: titleProperty(title),
        },
        children: markdownToBlocks(markdown),
      } as unknown as Parameters<typeof notion.pages.create>[0]);

      return {
        pageId: page.id,
        url: "url" in page ? page.url : undefined,
      };
    },

    async persistSectionsAndClaims({ workspace, sections, claims }) {
      const notion = getNotionClient();

      for (const section of sections) {
        await notion.pages.create({
          parent: { database_id: workspace.databases.docSections },
          properties: {
            Name: titleProperty(section.title),
            Repo: richTextProperty(section.repoFullName),
            "Source Hash": richTextProperty(section.sourceMarkdownHash),
            "Rendered Hash": richTextProperty(section.renderedNotionHash),
            "Claim IDs": richTextProperty(section.claimIds.join(", ")),
            "Section Page": urlProperty(section.notionUrl),
            "Section Page ID": richTextProperty(section.notionPageId ?? ""),
            "Source Snapshot": richTextProperty(JSON.stringify(section.sourceSnapshot).slice(0, 1900)),
          },
        } as unknown as Parameters<typeof notion.pages.create>[0]);
      }

      for (const claim of claims) {
        await notion.pages.create({
          parent: { database_id: workspace.databases.docClaims },
          properties: {
            Claim: titleProperty(claim.text),
            Kind: selectProperty(claim.kind),
            Status: selectProperty(claim.staleStatus),
            "Section ID": richTextProperty(claim.sectionId),
            "Covered Paths": richTextProperty(claim.coveredPaths.join("\n")),
            Concepts: richTextProperty(claim.concepts.join(", ")),
            Evidence: richTextProperty(claim.evidenceRefs.join("\n")),
            Confidence: { number: claim.confidence },
          },
        } as unknown as Parameters<typeof notion.pages.create>[0]);
      }
    },

    async recordMergedPr({ workspace, event }) {
      const notion = getNotionClient();
      await notion.pages.create({
        parent: { database_id: workspace.databases.mergedPrs },
        properties: {
          Title: titleProperty(event.title),
          "PR Number": { number: event.number },
          URL: urlProperty(event.htmlUrl),
          "Base Branch": richTextProperty(event.baseBranch),
          "Merge Commit": richTextProperty(event.mergeCommitSha ?? ""),
          "Changed Files": richTextProperty(event.changedFiles.join("\n")),
        },
      } as unknown as Parameters<typeof notion.pages.create>[0]);
    },

    async recordDocUpdateRun({ workspace, run }) {
      const notion = getNotionClient();
      await notion.pages.create({
        parent: { database_id: workspace.databases.docUpdateRuns },
        properties: {
          Name: titleProperty(`Doc update ${run.id.slice(0, 8)}`),
          Status: selectProperty(run.status),
          "PR Number": run.event ? { number: run.event.number } : undefined,
          Summary: richTextProperty(run.logs.at(-1) ?? ""),
          "Impacted Claims": richTextProperty(run.impactedClaimIds.join(", ")),
        },
      } as unknown as Parameters<typeof notion.pages.create>[0]);
    },

    async createReviewTask({ workspace, task }) {
      const notion = getNotionClient();
      const page = await notion.pages.create({
        parent: { database_id: workspace.databases.reviewQueue },
        properties: {
          Title: titleProperty(task.title),
          Status: selectProperty("open"),
          Reason: richTextProperty(task.reason),
          "PR URL": urlProperty(task.prUrl),
          "Changed Files": richTextProperty(task.changedFiles.join("\n")),
          "Affected Claims": richTextProperty(task.affectedClaimIds.join(", ")),
          Evidence: richTextProperty(task.evidenceRefs.join("\n")),
          Question: richTextProperty(task.unresolvedQuestion),
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
      const blocks = await notion.blocks.children.list({
        block_id: section.notionPageId,
        page_size: 100,
      });
      const text = blocks.results.map(extractPlainText).filter(Boolean).join("\n");
      return stableHash(text);
    },

    async replaceSectionContent(section, markdown) {
      if (!section.notionPageId) {
        return stableHash(markdown);
      }

      const notion = getNotionClient();
      const blocks = await notion.blocks.children.list({
        block_id: section.notionPageId,
        page_size: 100,
      });

      for (const block of blocks.results) {
        if ("id" in block) {
          await notion.blocks.delete({ block_id: block.id });
        }
      }

      await notion.blocks.children.append({
        block_id: section.notionPageId,
        children: markdownToBlocks(markdown),
      } as unknown as Parameters<typeof notion.blocks.children.append>[0]);

      return stableHash(markdownToPlainText(markdown));
    },
  };
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

function markdownToBlocks(markdown: string): Array<Record<string, unknown>> {
  return markdown
    .split("\n")
    .slice(0, 90)
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.length > 0 || index === lines.length - 1)
    .map((line) => {
      if (line.startsWith("### ")) {
        return headingBlock("heading_3", line.slice(4));
      }
      if (line.startsWith("## ")) {
        return headingBlock("heading_2", line.slice(3));
      }
      if (line.startsWith("# ")) {
        return headingBlock("heading_1", line.slice(2));
      }
      if (line.startsWith("- ")) {
        return {
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: { rich_text: text(line.slice(2)) },
        };
      }
      return {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: line ? text(line) : [] },
      };
    });
}

function headingBlock(type: "heading_1" | "heading_2" | "heading_3", content: string) {
  return {
    object: "block",
    type,
    [type]: { rich_text: text(content) },
  };
}

function text(content: string) {
  return [{ type: "text", text: { content: truncate(content, 1900) } }];
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
