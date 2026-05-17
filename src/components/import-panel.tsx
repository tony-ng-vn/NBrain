"use client";

import { useEffect, useMemo, useState } from "react";

type SerializedImportRun = {
  id: string;
  status: string;
  logs: string[];
  error?: string;
  hubUrl?: string;
  sections: Array<{
    id: string;
    title: string;
    notionUrl?: string;
    claimIds: string[];
  }>;
  claims: Array<{
    id: string;
    text: string;
    kind: string;
    staleStatus: string;
    coveredPaths: string[];
  }>;
};

type SerializedUpdateRun = {
  id: string;
  status: string;
  event?: {
    number: number;
    title: string;
    htmlUrl?: string;
  };
  impactedClaimIds: string[];
  changedFiles: string[];
  appliedSectionIds: string[];
  reviewTasks: Array<{
    id: string;
    title: string;
    reason: string;
    unresolvedQuestion: string;
    notionPageUrl?: string;
  }>;
  logs: string[];
  error?: string;
};

export function ImportPanel() {
  const [githubUrl, setGithubUrl] = useState("https://github.com/acme/demo");
  const [notionParentPageId, setNotionParentPageId] = useState("");
  const [run, setRun] = useState<SerializedImportRun | null>(null);
  const [updateRuns, setUpdateRuns] = useState<SerializedUpdateRun[]>([]);
  const [busy, setBusy] = useState<"import" | "safe-update" | "review-task" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canReplay = run?.status === "completed";
  const claimCount = run?.claims.length ?? 0;
  const sectionCount = run?.sections.length ?? 0;

  useEffect(() => {
    if (!run || run.status === "completed" || run.status === "failed") {
      return;
    }

    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/import/${run.id}`);

      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as {
        run: SerializedImportRun;
        updateRuns: SerializedUpdateRun[];
      };
      setRun(payload.run);
      setUpdateRuns(payload.updateRuns);
    }, 1200);

    return () => window.clearInterval(timer);
  }, [run]);

  async function importRepository() {
    setBusy("import");
    setError(null);
    setUpdateRuns([]);

    try {
      const response = await fetch("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          githubUrl,
          notionParentPageId: notionParentPageId.trim() || undefined,
        }),
      });
      const payload = (await response.json()) as {
        run?: SerializedImportRun;
        error?: string;
      };

      if (!response.ok || !payload.run) {
        throw new Error(payload.error ?? "Import failed.");
      }

      setRun(payload.run);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Import failed.");
    } finally {
      setBusy(null);
    }
  }

  async function replayFixture(fixture: "safe-update" | "review-task") {
    if (!run) {
      return;
    }

    setBusy(fixture);
    setError(null);

    try {
      const response = await fetch("/api/demo/replay-merged-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          importRunId: run.id,
          fixture,
        }),
      });
      const payload = (await response.json()) as {
        updateRun?: SerializedUpdateRun;
        error?: string;
      };

      if (!response.ok || !payload.updateRun) {
        throw new Error(payload.error ?? "Replay failed.");
      }

      setUpdateRuns((current) => [payload.updateRun!, ...current]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Replay failed.");
    } finally {
      setBusy(null);
    }
  }

  const latestUpdate = useMemo(() => updateRuns[0], [updateRuns]);

  return (
    <div className="workspace">
      <section className="panel">
        <div className="panel-header">
          <h2>Repository Import</h2>
          <p>GitHub URL, Notion parent page, managed Repo Guide output.</p>
        </div>
        <div className="panel-body stack">
          <label className="field">
            <span>GitHub repository</span>
            <input
              className="input"
              value={githubUrl}
              onChange={(event) => setGithubUrl(event.target.value)}
              placeholder="https://github.com/owner/repo"
            />
          </label>
          <label className="field">
            <span>Notion parent page</span>
            <input
              className="input"
              value={notionParentPageId}
              onChange={(event) => setNotionParentPageId(event.target.value)}
              placeholder="Uses NOTION_PARENT_PAGE_ID when empty"
            />
          </label>
          <div className="form-row">
            <button
              className="button"
              type="button"
              onClick={importRepository}
              disabled={busy !== null || githubUrl.trim().length === 0}
            >
              {busy === "import" ? "Importing" : "Import"}
            </button>
            {run?.hubUrl ? (
              <a className="button secondary link-button" href={run.hubUrl} target="_blank">
                Open Notion Hub
              </a>
            ) : null}
          </div>
          {error ? <p className="error-text">{error}</p> : null}
          {run ? (
            <div className="run-card">
              <strong>Import {run.status}</strong>
              <div className="meta-grid">
                <div>
                  <span>Run</span> {run.id.slice(0, 8)}
                </div>
                <div>
                  <span>Sections</span> {sectionCount}
                </div>
                <div>
                  <span>Claims</span> {claimCount}
                </div>
              </div>
              {run.error ? <p className="error-text">{run.error}</p> : null}
              <ol className="log-list">
                {run.logs.slice(-6).map((log, index) => (
                  <li key={`${log}-${index}`}>{log}</li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      </section>

      <aside className="panel">
        <div className="panel-header">
          <h3>Merged PR Replay</h3>
          <p>Safe update fixture and weak-evidence review fixture.</p>
        </div>
        <div className="panel-body stack">
          <button
            className="button"
            type="button"
            onClick={() => replayFixture("safe-update")}
            disabled={!canReplay || busy !== null}
          >
            {busy === "safe-update" ? "Replaying" : "Replay Safe PR"}
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() => replayFixture("review-task")}
            disabled={!canReplay || busy !== null}
          >
            {busy === "review-task" ? "Replaying" : "Replay Review PR"}
          </button>

          {latestUpdate ? (
            <div className="run-card">
              <strong>Update {latestUpdate.status}</strong>
              <div className="meta-grid">
                <div>
                  <span>PR</span> #{latestUpdate.event?.number ?? "fixture"}
                </div>
                <div>
                  <span>Changed</span> {latestUpdate.changedFiles.join(", ") || "none"}
                </div>
                <div>
                  <span>Impacted</span> {latestUpdate.impactedClaimIds.length}
                </div>
                <div>
                  <span>Applied</span> {latestUpdate.appliedSectionIds.length}
                </div>
                <div>
                  <span>Reviews</span> {latestUpdate.reviewTasks.length}
                </div>
              </div>
              {latestUpdate.error ? <p className="error-text">{latestUpdate.error}</p> : null}
              {latestUpdate.reviewTasks.map((task) => (
                <div className="review-task" key={task.id}>
                  <strong>{task.title}</strong>
                  <p>{task.reason}</p>
                  <p>{task.unresolvedQuestion}</p>
                  {task.notionPageUrl ? (
                    <a href={task.notionPageUrl} target="_blank">
                      Open review task
                    </a>
                  ) : null}
                </div>
              ))}
              <ol className="log-list">
                {latestUpdate.logs.slice(-5).map((log, index) => (
                  <li key={`${log}-${index}`}>{log}</li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
