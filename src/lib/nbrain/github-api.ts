import { Octokit } from "@octokit/rest";
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
