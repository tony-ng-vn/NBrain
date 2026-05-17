# NBrain Notion Worker

This Worker powers the Notion-native NBrain demo:

```text
GitHub merged PR webhook
  -> NBrain Worker
  -> Merged PRs row marked Ready for Agent
  -> Notion Custom Agent trigger
  -> Worker tools
  -> verified doc update or Review Queue task
```

## Capabilities

Webhook:

- `githubPullRequestWebhook`

Custom Agent tools:

- `get_pr_context`
- `find_impacted_claims`
- `get_managed_section`
- `get_repo_context_bundle`
- `propose_doc_patch`
- `create_review_task`

## Local Checks

```bash
npm install
npm run check
npm run build
```

## Environment

Use local ignored env files and Worker secrets. Do not commit secret values.

Required:

```bash
NOTION_API_TOKEN=
GITHUB_TOKEN=
GITHUB_WEBHOOK_SECRET=
NBRAIN_MERGED_PRS_DATABASE_ID=
NBRAIN_REVIEW_QUEUE_DATABASE_ID=
NBRAIN_DOC_SECTIONS_DATABASE_ID=
NBRAIN_DOC_CLAIMS_DATABASE_ID=
NBRAIN_DOC_UPDATE_RUNS_DATABASE_ID=
```

Optional:

```bash
DEEPWIKI_MCP_URL=https://mcp.deepwiki.com/mcp
```

## Deploy

```bash
ntn workers deploy
ntn workers env push --file ../../.env.local
ntn workers webhooks list
```

Add the `githubPullRequestWebhook` URL to GitHub repo settings as a `Pull requests` webhook with `application/json` content and the same `GITHUB_WEBHOOK_SECRET`.
