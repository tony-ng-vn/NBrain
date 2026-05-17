import { z } from "zod";
import { MergedPrEventSchema, type MergedPrEvent } from "./schemas";

export type ParsedGitHubRepo = {
  owner: string;
  repo: string;
  githubUrl: string;
  fullName: string;
};

const repoPartPattern = /^[A-Za-z0-9_.-]+$/;

export function parseGitHubRepoUrl(input: string): ParsedGitHubRepo {
  const trimmed = input.trim();
  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Enter a valid GitHub repository URL.");
  }

  if (url.hostname !== "github.com") {
    throw new Error("Only github.com repository URLs are supported.");
  }

  const [owner, rawRepo, ...rest] = url.pathname
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);

  if (!owner || !rawRepo || rest.length > 0) {
    throw new Error("Use a GitHub repository URL like https://github.com/owner/repo.");
  }

  const repo = rawRepo.replace(/\.git$/, "");

  if (!repoPartPattern.test(owner) || !repoPartPattern.test(repo)) {
    throw new Error("GitHub owner and repository names contain invalid characters.");
  }

  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    githubUrl: `https://github.com/${owner}/${repo}`,
  };
}

const PullRequestWebhookSchema = z.object({
  action: z.string(),
  repository: z.object({
    name: z.string(),
    owner: z.object({
      login: z.string(),
    }),
  }),
  pull_request: z.object({
    number: z.number(),
    title: z.string().default(""),
    body: z.string().nullable().optional(),
    merged: z.boolean().default(false),
    html_url: z.string().url().optional(),
    merge_commit_sha: z.string().nullable().optional(),
    base: z.object({
      ref: z.string(),
    }),
  }),
});

export type WebhookParseResult =
  | { ignored: true; reason: string }
  | { ignored: false; event: MergedPrEvent };

export function parseMergedPrWebhookPayload(payload: unknown): WebhookParseResult {
  const parsed = PullRequestWebhookSchema.safeParse(payload);

  if (!parsed.success) {
    return { ignored: true, reason: "invalid_pull_request_payload" };
  }

  const { action, pull_request: pullRequest, repository } = parsed.data;

  if (action !== "closed") {
    return { ignored: true, reason: "not_pull_request_closed" };
  }

  if (!pullRequest.merged) {
    return { ignored: true, reason: "pull_request_not_merged" };
  }

  if (pullRequest.base.ref !== "main") {
    return { ignored: true, reason: "base_branch_not_main" };
  }

  return {
    ignored: false,
    event: MergedPrEventSchema.parse({
      repo: {
        owner: repository.owner.login,
        repo: repository.name,
      },
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body ?? "",
      baseBranch: pullRequest.base.ref,
      merged: pullRequest.merged,
      mergeCommitSha: pullRequest.merge_commit_sha ?? undefined,
      htmlUrl: pullRequest.html_url,
      changedFiles: [],
    }),
  };
}
