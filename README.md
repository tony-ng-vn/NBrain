# NBrain

NBrain is a prototype for living repo documentation in Notion. It imports a
public GitHub repository, bootstraps a Repo Guide from DeepWiki, extracts
claim/evidence records, and uses merged PR evidence to either update managed
docs safely or create Review Queue tasks.

The current root app is a Next.js demo harness. The product direction is
Notion-native: a Notion Worker receives GitHub events, writes update context
into Notion, and gives a Notion Custom Agent tools for bounded context
retrieval, verified doc patches, and review-task creation.

## Current app flow

1. Open the Next.js app and enter a GitHub repository URL.
2. Optionally provide a Notion parent page ID; otherwise the app reads
   `NOTION_PARENT_PAGE_ID`.
3. `POST /api/import` validates the repo, reads DeepWiki content, creates a
   Notion hub, writes Repo Guide sections, and stores Doc Claims.
4. The UI polls `GET /api/import/[runId]` for run status and links to the
   generated Notion hub.
5. The demo replay buttons call `POST /api/demo/replay-merged-pr` with fixture
   PR events. A safe fixture applies a managed section update; a weak-evidence
   fixture creates a Review Queue task.
6. `POST /api/github/webhook` is available as the web-app webhook path for
   merged pull requests, but the Notion Worker is the planned primary webhook
   owner.

Prototype limits: run state is in memory, DeepWiki/OpenAI calls have fallback
paths for local verification, and production tenant auth/storage is not yet the
focus of this root app.

## Notion Worker and Custom Agent direction

The planned Notion-native loop is:

```text
GitHub merged PR webhook
  -> NBrain Notion Worker
  -> Merged PRs database row marked Ready for Agent
  -> Notion Custom Agent trigger
  -> Agent calls NBrain Worker tools
  -> Worker verifies and applies safe doc updates or creates Review Queue tasks
```

For the demo, the Custom Agent is configured in Notion to trigger when a
`Merged PRs` row changes to `Ready for Agent`. The Worker owns the GitHub
signature check, changed-file lookup, impacted-claim matching, safe patch
verification, Notion writes, and review-task fallback.

Expected Worker tools:

- `get_pr_context`
- `find_impacted_claims`
- `get_managed_section`
- `get_repo_context_bundle`
- `propose_doc_patch`
- `create_review_task`

The Custom Agent should not write managed Repo Guide pages directly. It should
submit structured patch proposals to the Worker, and the Worker decides whether
to apply the patch or create a review task.

## Setup

Install app dependencies:

```bash
bun install
```

Create a local env file:

```bash
cp .env.example .env.local
```

Run the app:

```bash
bun run dev
```

Then open `http://localhost:3000`.

## Environment variables

Root Next.js app:

- `NOTION_TOKEN`
- `NOTION_PARENT_PAGE_ID`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `GITHUB_TOKEN`
- `GITHUB_WEBHOOK_SECRET`
- `DEEPWIKI_MCP_URL`

Notion Worker demo:

- `GITHUB_TOKEN`
- `GITHUB_WEBHOOK_SECRET`
- `NBRAIN_MERGED_PRS_DATABASE_ID`
- `NBRAIN_REVIEW_QUEUE_DATABASE_ID`
- `NBRAIN_DOC_SECTIONS_DATABASE_ID`
- `NBRAIN_DOC_CLAIMS_DATABASE_ID`
- `NBRAIN_DOC_UPDATE_RUNS_DATABASE_ID`
- `DEEPWIKI_MCP_URL`
- `NOTION_API_TOKEN` if the Worker is configured with explicit Notion API auth

Do not commit real secret values.

## Verification

Root app checks:

```bash
bun test
bun run build
```

Worker checks, once the Worker workspace is ready:

```bash
cd workers/nbrain-worker
npm install
npm run check
npm run build
```

After deploying a Worker, use the Notion CLI to inspect webhook URLs and test
tools locally or against the deployed Worker, for example:

```bash
ntn workers webhooks list
ntn workers exec get_repo_context_bundle --local -d '{"prNumber": 123}'
```
