import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type DeepWikiSection = {
  title: string;
  markdown: string;
  sourceSnapshot: Record<string, unknown>;
};

export async function readDeepWikiRepoGuide(repoFullName: string): Promise<DeepWikiSection[]> {
  const endpoint = process.env.DEEPWIKI_MCP_URL ?? "https://mcp.deepwiki.com/mcp";

  try {
    const client = new Client({ name: "nbrain", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint));
    await client.connect(transport);

    try {
      const [structure, contents] = await Promise.all([
        callDeepWikiTool(client, "read_wiki_structure", repoFullName),
        callDeepWikiTool(client, "read_wiki_contents", repoFullName),
      ]);

      const sections = splitMarkdownSections(contents, repoFullName)
        .filter(hasUsefulWikiContent)
        .map((section) => ({
          ...section,
          sourceSnapshot: {
            provider: "deepwiki",
            endpoint,
            repoFullName,
            structure: structure.slice(0, 4000),
          },
        }));

      return sections.length > 0 ? sections : fallbackDeepWikiSections(repoFullName, "empty");
    } finally {
      await client.close();
    }
  } catch (error) {
    return fallbackDeepWikiSections(
      repoFullName,
      error instanceof Error ? error.message : "unknown_error",
    );
  }
}

async function callDeepWikiTool(
  client: Client,
  name: "read_wiki_structure" | "read_wiki_contents",
  repoFullName: string,
): Promise<string> {
  try {
    return extractToolText(
      await client.callTool({
        name,
        arguments: { repoName: repoFullName },
      }),
    );
  } catch {
    return extractToolText(
      await client.callTool({
        name,
        arguments: { repository: repoFullName },
      }),
    );
  }
}

function extractToolText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }

  const content = (result as Record<string, unknown>).content;

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const record = block as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        return record.text;
      }
      return JSON.stringify(record);
    })
    .filter(Boolean)
    .join("\n");
}

function splitMarkdownSections(markdown: string, repoFullName: string): DeepWikiSection[] {
  const normalized = markdown.trim();

  if (!normalized) {
    return [];
  }

  const pageChunks = normalized.split(/\n(?=# Page:\s+)/g).filter(Boolean);
  const chunks = pageChunks.length > 1 ? pageChunks : normalized.split(/\n(?=#{1,2}\s+)/g).filter(Boolean);
  const selected = chunks.length > 1 ? chunks : [normalized];

  return selected.map((chunk, index) => {
    const title =
      chunk.match(/^# Page:\s+(.+)$/m)?.[1]?.trim() ??
      chunk.match(/^#{1,2}\s+(.+)$/m)?.[1]?.trim() ??
      ["Repo Guide", "Architecture", "Usage", "Data Flow", "Operational Notes"][index] ??
      `Section ${index + 1}`;

    return {
      title,
      markdown: chunk.startsWith("#") ? chunk : `# ${title}\n\n${chunk}`,
      sourceSnapshot: {
        provider: "deepwiki",
        repoFullName,
      },
    };
  });
}

function hasUsefulWikiContent(section: DeepWikiSection): boolean {
  const plain = section.markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\[[^\]]+\]\([^)]*\)/g, "")
    .replace(/[`*_>-]/g, "")
    .trim();

  return plain.length > 120;
}

function fallbackDeepWikiSections(repoFullName: string, reason: string): DeepWikiSection[] {
  return [
    {
      title: "Repo Guide",
      markdown: [
        "# Repo Guide",
        "",
        `Repository: ${repoFullName}`,
        "",
        "DeepWiki content was not available during this run. NBrain still creates a managed hub so the replay flow can be verified.",
        "",
        "- Primary source path: README.md",
        "- Managed output: Repo Guide, Claims & Evidence, Review Queue",
      ].join("\n"),
      sourceSnapshot: {
        provider: "deepwiki",
        fallback: true,
        reason,
      },
    },
  ];
}
