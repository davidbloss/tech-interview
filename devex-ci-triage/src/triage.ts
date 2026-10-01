// ---------------------------------------------------------------------------
// The action's entry point. This file is the wiring and nothing else: read the
// failed jobs, hand each log to the model, hand the results to the renderer,
// post one comment. Every decision about what a result means lives in
// src/triage-core.ts, which takes the model call as a parameter and can
// therefore be tested without a comment store.
// ---------------------------------------------------------------------------

import { getFailedJobs, classify, listComments, createComment, updateComment } from "./fixtures.js";
import { MARKER, renderBody, renderEmptyBody, triageJob } from "./triage-core.js";

// This Action runs on every push, so we keep one comment and replace its body.
// The marker is what finds it. updateComment throws on a missing id
// (fixtures.ts:247) and two pushes can land at once, so a failed update falls
// back to creating rather than losing the comment entirely.
async function postOrUpdate(body: string): Promise<void> {
  const existing = await listComments();
  const ours = existing.find((comment) => comment.body.includes(MARKER));

  if (ours) {
    try {
      await updateComment(ours.id, body);
      return;
    } catch {
      // The comment vanished between listComments and updateComment. Post a
      // new one rather than dropping this run's triage on the floor.
    }
  }

  await createComment(body);
}

export async function runTriage(): Promise<void> {
  const jobs = await getFailedJobs();

  if (jobs.length === 0) {
    // A stale "12 jobs failed" comment on a now-green PR is worse than a
    // one-liner, so replace it either way.
    await postOrUpdate(renderEmptyBody());
    return;
  }

  // One slow model call per job, run together. Wall clock is the slowest job
  // rather than the sum of all of them. triageJob cannot reject, so one bad
  // model response can't sink the run.
  const results = await Promise.all(jobs.map((job) => triageJob(job, classify)));

  await postOrUpdate(renderBody(results));
}
