import { Octokit } from "@octokit/rest";
import type { DeepWikiSection } from "./deepwiki";
import type { MergedPrEvent, RepoSource } from "./schemas";
import type { ParsedGitHubRepo } from "./github";

let octokit: Octokit | undefined;

function getOctokit(): Octokit {
  octokit ??= new Octokit({
    auth: process.env.GITHUB_TOKEN || undefined,
  });
  return octokit;
}

export async function fetchRepoSource(parsed: ParsedGitHubRepo): Promise<RepoSource> {
  try {
    const response = await getOctokit().rest.repos.get({
      owner: parsed.owner,
      repo: parsed.repo,
    });

    return {
      owner: parsed.owner,
      repo: parsed.repo,
      githubUrl: parsed.githubUrl,
      defaultBranch: response.data.default_branch || "main",
    };
  } catch {
    return {
      owner: parsed.owner,
      repo: parsed.repo,
      githubUrl: parsed.githubUrl,
      defaultBranch: "main",
    };
  }
}

export async function fetchPullRequestFiles(event: MergedPrEvent): Promise<string[]> {
  if (event.changedFiles.length > 0) {
    return event.changedFiles;
  }

  const files = await getOctokit().paginate(getOctokit().rest.pulls.listFiles, {
    owner: event.repo.owner,
    repo: event.repo.repo,
    pull_number: event.number,
    per_page: 100,
  });

  return files.map((file) => file.filename);
}

export async function readGitHubRepoGuide(
  parsed: ParsedGitHubRepo,
): Promise<DeepWikiSection[]> {
  const octokit = getOctokit();
  const [repoResponse, readme, rootPaths] = await Promise.all([
    octokit.rest.repos.get({
      owner: parsed.owner,
      repo: parsed.repo,
    }).catch(() => null),
    fetchReadme(parsed),
    fetchRootPaths(parsed),
  ]);
  const repo = repoResponse?.data;
  const treePaths = await fetchTreePaths(parsed, repo?.default_branch ?? "main");
  const referencePaths = selectReferencePaths(treePaths.length > 0 ? treePaths : rootPaths);
  const fileSnapshots = await fetchFileSnapshots(parsed, referencePaths.slice(0, 10));

  const sections: DeepWikiSection[] = [
    {
      title: "Repo Overview",
      markdown: [
        "# Repo Overview",
        "",
        `Repository: ${parsed.fullName}`,
        `GitHub: ${parsed.githubUrl}`,
        `Default branch: ${repo?.default_branch ?? "main"}`,
        repo?.description ? `Description: ${repo.description}` : "",
        "",
        "## Reference Paths",
        "",
        ...referencePaths.slice(0, 12).map((path) => `- ${path}`),
        "",
        "## README",
        "",
        readme || "README content was not available from GitHub during this import.",
      ].filter(Boolean).join("\n"),
      sourceSnapshot: {
        provider: "github",
        repoFullName: parsed.fullName,
        fallbackFrom: "deepwiki_unavailable",
        referencePaths,
      },
    },
    codebaseMapSection(parsed, treePaths.length > 0 ? treePaths : rootPaths, referencePaths),
  ];

  const appSection = sourcePathSection(
    "App Routes and API Surface",
    referencePaths.filter((path) => path.startsWith("src/app/")),
    fileSnapshots,
  );
  if (appSection) sections.push(appSection);

  const runtimeSection = sourcePathSection(
    "Runtime, Data, and Configuration",
    referencePaths.filter(
      (path) =>
        path === "package.json" ||
        path.includes("config") ||
        path.startsWith("convex/") ||
        path.startsWith("transcript-service/") ||
        path.startsWith("src/lib/"),
    ),
    fileSnapshots,
  );
  if (runtimeSection) sections.push(runtimeSection);

  const docsTestsSection = sourcePathSection(
    "Docs and Tests",
    referencePaths.filter((path) => path.startsWith("docs/") || path.startsWith("tests/")),
    fileSnapshots,
  );
  if (docsTestsSection) sections.push(docsTestsSection);

  return sections.slice(0, 5);
}

async function fetchReadme(parsed: ParsedGitHubRepo): Promise<string> {
  try {
    const response = await getOctokit().rest.repos.getReadme({
      owner: parsed.owner,
      repo: parsed.repo,
      mediaType: { format: "raw" },
    });
    const data = response.data as unknown;
    return typeof data === "string" ? data.slice(0, 12000) : "";
  } catch {
    return "";
  }
}

async function fetchRootPaths(parsed: ParsedGitHubRepo): Promise<string[]> {
  try {
    const response = await getOctokit().rest.repos.getContent({
      owner: parsed.owner,
      repo: parsed.repo,
      path: "",
    });

    if (!Array.isArray(response.data)) {
      return [];
    }

    return response.data
      .map((item) => item.path)
      .filter((path): path is string => Boolean(path))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function fetchTreePaths(parsed: ParsedGitHubRepo, branch: string): Promise<string[]> {
  try {
    const response = await getOctokit().rest.git.getTree({
      owner: parsed.owner,
      repo: parsed.repo,
      tree_sha: branch,
      recursive: "true",
    });

    return response.data.tree
      .filter((item) => item.type === "blob")
      .map((item) => item.path)
      .filter((path): path is string => Boolean(path))
      .filter((path) => !isIgnoredPath(path))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function fetchFileSnapshots(
  parsed: ParsedGitHubRepo,
  paths: string[],
): Promise<Array<{ path: string; content: string }>> {
  const snapshots = await Promise.all(
    paths.map(async (path) => {
      if (!isTextPath(path)) {
        return null;
      }

      try {
        const response = await getOctokit().rest.repos.getContent({
          owner: parsed.owner,
          repo: parsed.repo,
          path,
          mediaType: { format: "raw" },
        });
        const data = response.data as unknown;
        return typeof data === "string" ? { path, content: data.slice(0, 2500) } : null;
      } catch {
        return null;
      }
    }),
  );

  return snapshots.filter((snapshot): snapshot is { path: string; content: string } =>
    Boolean(snapshot),
  );
}

function codebaseMapSection(
  parsed: ParsedGitHubRepo,
  paths: string[],
  referencePaths: string[],
): DeepWikiSection {
  const topLevel = Array.from(new Set(paths.map((path) => path.split("/")[0]).filter(Boolean))).slice(0, 16);

  return {
    title: "Codebase Map",
    markdown: [
      "# Codebase Map",
      "",
      `Repository: ${parsed.fullName}`,
      "",
      "## Top-level areas",
      "",
      ...topLevel.map((path) => `- ${path}`),
      "",
      "## Primary source paths",
      "",
      ...referencePaths.map((path) => `- ${path}`),
    ].join("\n"),
    sourceSnapshot: {
      provider: "github",
      repoFullName: parsed.fullName,
      fallbackFrom: "deepwiki_unavailable",
      referencePaths,
    },
  };
}

function sourcePathSection(
  title: string,
  paths: string[],
  fileSnapshots: Array<{ path: string; content: string }>,
): DeepWikiSection | null {
  const selectedPaths = Array.from(new Set(paths)).slice(0, 8);
  if (selectedPaths.length === 0) {
    return null;
  }

  const snapshots = fileSnapshots.filter((snapshot) => selectedPaths.includes(snapshot.path));

  return {
    title,
    markdown: [
      `# ${title}`,
      "",
      "## Primary source paths",
      "",
      ...selectedPaths.map((path) => `- ${path}`),
      "",
      "## Source excerpts",
      "",
      ...snapshots.flatMap((snapshot) => [
        `### ${snapshot.path}`,
        "",
        "```",
        snapshot.content,
        "```",
        "",
      ]),
    ].join("\n"),
    sourceSnapshot: {
      provider: "github",
      fallbackFrom: "deepwiki_unavailable",
      referencePaths: selectedPaths,
    },
  };
}

function selectReferencePaths(paths: string[]): string[] {
  const candidates = paths.filter((path) => !isIgnoredPath(path));
  const priority = [
    "README.md",
    "package.json",
    "next.config.ts",
    "convex.json",
    "convex/schema.ts",
    "src/app/page.tsx",
    "src/app/layout.tsx",
    "src/app/api/chat/route.ts",
    "src/app/api/episodes/route.ts",
    "src/lib/chat/system-prompt.ts",
    "src/lib/llm/index.ts",
    "src/lib/llm/openrouter.ts",
    "src/lib/youtube.ts",
    "transcript-service/main.py",
    "docs/feature.md",
    "docs/changelog.md",
  ];
  const scored = candidates
    .map((path) => ({ path, score: referencePathScore(path, priority) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .map((entry) => entry.path);
  const selected = [...priority.filter((path) => candidates.includes(path)), ...scored];

  return Array.from(new Set(selected)).slice(0, 24);
}

function referencePathScore(path: string, priority: string[]): number {
  if (priority.includes(path)) return 1000 - priority.indexOf(path);
  if (path.startsWith("src/app/api/") && path.endsWith("/route.ts")) return 850;
  if (path.startsWith("src/app/") && path.endsWith("page.tsx")) return 800;
  if (path.startsWith("src/components/") && path.endsWith(".tsx")) return 650;
  if (path.startsWith("src/lib/") && /\.(ts|tsx)$/.test(path)) return 620;
  if (path.startsWith("convex/") && path.endsWith(".ts")) return 600;
  if (path.startsWith("docs/") && path.endsWith(".md")) return 450;
  if (path.startsWith("tests/") && /\.(test|spec)\.(ts|tsx)$/.test(path)) return 350;
  if (/config\.(ts|js|mjs|json)$/.test(path)) return 320;
  return 0;
}

function isIgnoredPath(path: string): boolean {
  return (
    path.includes("node_modules/") ||
    path.includes("/_generated/") ||
    path.endsWith(".ico") ||
    path.endsWith(".svg") ||
    path.endsWith(".png") ||
    path.endsWith(".jpg") ||
    path.endsWith(".jpeg") ||
    path.endsWith(".gif") ||
    path.endsWith(".lock") ||
    path.endsWith("package-lock.json")
  );
}

function isTextPath(path: string): boolean {
  return /\.(md|json|ts|tsx|js|jsx|mjs|cjs|py|txt|yml|yaml)$/.test(path);
}
