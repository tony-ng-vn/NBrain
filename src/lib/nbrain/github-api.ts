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
  const referencePaths = rootPaths.length > 0 ? rootPaths : ["README.md"];

  return [
    {
      title: "Repo Guide",
      markdown: [
        "# Repo Guide",
        "",
        `Repository: ${parsed.fullName}`,
        `GitHub: ${parsed.githubUrl}`,
        `Default branch: ${repo?.default_branch ?? "main"}`,
        repo?.description ? `Description: ${repo.description}` : "",
        "",
        "## Reference Paths",
        "",
        ...referencePaths.slice(0, 30).map((path) => `- ${path}`),
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
  ];
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
