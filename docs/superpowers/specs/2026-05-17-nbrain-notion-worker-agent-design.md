# NBrain Notion Worker + Custom Agent Design

## Goal

Build the Notion-native NBrain demo path:

```text
GitHub merged PR webhook
  -> NBrain Notion Worker
  -> Merged PRs database row marked Ready for Agent
  -> Notion Custom Agent trigger
  -> Agent calls NBrain Worker tools
  -> Worker verifies and applies safe doc updates or creates Review Queue tasks
```

The web app is no longer the main product surface for this flow. Notion is the primary product surface; the Worker owns integrations, safety, and writes.

## Demo Scope

The first demo is end-to-end but thin:

- receive a real GitHub `pull_request.closed` webhook
- process only merged PRs targeting `main`
- verify `X-Hub-Signature-256`
- fetch PR changed files through GitHub
- write a complete `Merged PRs` row in Notion
- set `Status = Ready for Agent` only after required metadata exists
- expose Worker tools for the Custom Agent
- accept structured patch proposals only through `propose_doc_patch`
- create Review Queue tasks when evidence is weak or verification fails

The Custom Agent is configured manually in Notion for this demo. Its trigger is:

```text
Property updated in database
Database: Merged PRs
Property: Status
Condition: Status is Ready for Agent
```

## Worker Capabilities

Webhook:

- `githubPullRequestWebhook`
  - verifies the GitHub webhook secret
  - ignores unsupported events
  - fetches changed files
  - creates/updates a Merged PR row
  - sets status to `Ready for Agent`

Tools:

- `get_pr_context`: returns PR metadata, changed files, and stored Notion row data
- `find_impacted_claims`: ranks Doc Claims by changed path and concept matches
- `get_managed_section`: returns one managed section and stored hashes
- `get_repo_context_bundle`: returns bounded PR + impacted claims + sections context
- `propose_doc_patch`: validates structured operations and applies safe updates or creates a review task
- `create_review_task`: creates a Review Queue task explicitly

## Safety Rules

The Custom Agent does not directly update managed Repo Guide pages.

The Worker verifier enforces:

- only impacted claims or sections can be targeted
- every non-skip operation must include evidence
- section replacement requires the stored rendered hash to match the current hash
- automatic claim or section deletion is not allowed in the demo
- weak evidence becomes a Review Queue task
- direct GitHub title/body claims are insufficient without changed-file evidence

## Required Secrets

Secrets are stored locally in ignored `.env.local` for development and pushed to the deployed Worker through `ntn workers env push`.

Required:

- `NOTION_API_TOKEN`
- `GITHUB_TOKEN`
- `GITHUB_WEBHOOK_SECRET`
- `NBRAIN_MERGED_PRS_DATABASE_ID`
- `NBRAIN_REVIEW_QUEUE_DATABASE_ID`
- `NBRAIN_DOC_SECTIONS_DATABASE_ID`
- `NBRAIN_DOC_CLAIMS_DATABASE_ID`
- `NBRAIN_DOC_UPDATE_RUNS_DATABASE_ID`

Optional:

- `DEEPWIKI_MCP_URL`

The Worker must not print secret values.

## Notion Database Contract

The Worker assumes these databases already exist:

- `Merged PRs`
- `Doc Claims`
- `Repo Guide Sections`
- `Doc Update Runs`
- `Review Queue`

The Merged PR flow uses these properties:

- `Name`
- `PR Number`
- `PR URL`
- `Base Branch`
- `Merge Commit`
- `Changed Files`
- `Status`
- `Impacted Claim IDs`
- `Impacted Section IDs`
- `Agent Summary`
- `Error`

## Implementation Notes

The existing Next.js prototype already contains useful deterministic logic:

- GitHub webhook parsing
- claim matching
- patch proposal schemas
- verifier rules
- Notion property conventions

The Worker implementation should reuse those concepts, but it can duplicate a small amount of code at first if importing shared code from the Next app complicates the Worker bundle.

## Verification

Before each commit:

- run the Worker typecheck/build command
- run the existing app tests when shared code changes
- test at least one local Worker tool with `ntn workers exec`
- after deploy, list webhook URLs and provide the GitHub webhook setup values

## References

- Notion Workers quickstart: https://developers.notion.com/workers/get-started/quickstart
- Notion Worker tools: https://developers.notion.com/workers/guides/tools
- Notion Worker webhooks: https://developers.notion.com/workers/guides/webhooks
- Notion Worker secrets: https://developers.notion.com/workers/guides/secrets
- Notion Worker Notion API auth: https://developers.notion.com/workers/guides/api-client
