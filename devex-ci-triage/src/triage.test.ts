// ---------------------------------------------------------------------------
// Tests for the triage pipeline. No test framework: node:test on Node 26
// strips the types natively, so `npm test` needs no dependency this repo
// doesn't already have.
//
// The fixtures are the source of truth for behavior, so most of these cases
// mirror a specific job in src/fixtures.ts. The ones that don't mirror
// anything are marked, because they cover failure modes the canned data can't
// produce on its own.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import { getFailedJobs, classify, type FailedJob } from "./fixtures.js";
import {
  capCause,
  isCategory,
  isConfidence,
  isTrusted,
  isUntrusted,
  MAX_JSON_SCAN,
  renderBody,
  retryingClassify,
  toTriage,
  triageJob,
  untrustedReason,
  unwrap,
  verdictLine,
  type TriageResult,
  type UntrustedResult,
  type WhyUntrusted,
} from "./triage-core.js";

function job(log: string, jobName = "test-job"): FailedJob {
  return { jobName, log, url: `https://ci.example.com/${jobName}/1` };
}

const VALID = {
  category: "test_failure",
  cause: "rounding is off by one",
  confidence: 0.9,
};

// ---------------------------------------------------------------------------
// unwrap
// ---------------------------------------------------------------------------

test("unwrap passes a well-formed object straight through", () => {
  const result = unwrap(VALID);
  assert.equal(result.kind, "value");
  assert.deepEqual(result.kind === "value" ? result.value : null, VALID);
});

test("unwrap reads JSON out of a markdown fence", () => {
  // Not in the fixtures. Real models fence JSON constantly, and an unfenced
  // reader turns the whole fence block into a diagnosis.
  const result = unwrap('```json\n{"category":"infra","cause":"db down","confidence":0.8}\n```');
  assert.equal(result.kind, "value");
  assert.deepEqual(result.kind === "value" ? result.value.category : null, "infra");
});

test("unwrap reads JSON out of surrounding prose", () => {
  // Not in the fixtures. The object is right there, fully parseable.
  const result = unwrap('Sure! Here it is: {"category":"infra","cause":"db down"} Hope that helps.');
  assert.equal(result.kind, "value");
  assert.deepEqual(result.kind === "value" ? result.value.cause : null, "db down");
});

test("unwrap keeps a brace that sits inside a string value", () => {
  // Not in the fixtures. A depth-counting brace matcher closes early on the
  // `}` inside the string and reports unparseable JSON.
  const result = unwrap('{"category":"test_failure","cause":"expected } but got {"}');
  assert.equal(result.kind, "value");
});

test("unwrap strips quotes from a JSON-encoded string", () => {
  // Not in the fixtures. A bare category is the right value in the wrong
  // wrapper, and the quotes should not reach the PR comment.
  const result = unwrap('"test_failure"');
  assert.equal(result.kind, "prose");
  assert.equal(result.kind === "prose" ? result.prose : null, "test_failure");
});

test("unwrap handles a double-encoded object once", () => {
  const result = unwrap(JSON.stringify(JSON.stringify(VALID)));
  assert.equal(result.kind, "value");
  assert.deepEqual(result.kind === "value" ? result.value.category : null, "test_failure");
});

test("unwrap stops after one re-unwrap instead of nesting", () => {
  // Three levels of encoding is not a thing models do. It should land as
  // prose, not spin or invent a nested-JSON failure mode.
  const result = unwrap(JSON.stringify(JSON.stringify(JSON.stringify(VALID))));
  assert.equal(result.kind, "prose");
});

test("unwrap reports model truncation as truncation, not as a parse failure", () => {
  // fixtures.ts: security-scan. The model had the right answer and got cut
  // off mid-string. We don't recover it, but we say what actually happened,
  // and we say the model is who dropped it.
  const result = unwrap('{"category":"dependency","cause":"vuln in lo');
  assert.equal(result.kind, "cut_off_by_model");
});

test("unwrap separates malformed JSON from truncation", () => {
  // Balanced braces, invalid contents. Different problem, different reason.
  const result = unwrap('{"category": }');
  assert.equal(result.kind, "unparseable");
});

test("unwrap finishes an object that opens inside the scan window", () => {
  // Not in the fixtures. A valid classification whose opening brace lands just
  // under MAX_JSON_SCAN and whose closing brace lands well past it. The window
  // is a ceiling on how much prose we're willing to read, not a wall we stop
  // at, so a right answer that starts inside it should survive intact.
  const payload = JSON.stringify(VALID);
  const buried = `${"x".repeat(MAX_JSON_SCAN - payload.length / 2)} ${payload}`;

  assert.ok(buried.length > MAX_JSON_SCAN, "the payload has to run past the window");
  assert.ok(buried.indexOf("{") < MAX_JSON_SCAN, "the object has to open inside it");

  const result = unwrap(buried);
  assert.equal(result.kind, "value");
  assert.deepEqual(result.kind === "value" ? result.value : null, VALID);
});

test("unwrap blames our scan cap, not the model, when there was no object to find", () => {
  // Not in the fixtures, and not something a correct model does. What this
  // pins down is the reporting: a response too long for us to find an object in
  // could still have one past the cap, so we didn't read what the model said.
  // Saying "it wrote a sentence" would be us quoting 200 characters of a tail
  // we never looked at. The two truncations have opposite fixes.
  const result = unwrap("x".repeat(MAX_JSON_SCAN + 500));
  assert.equal(result.kind, "cut_off_by_us");
});

test("unwrap keeps plain prose as prose", () => {
  // fixtures.ts: unit-payments.
  const result = unwrap("The payments test failed on a null refund.");
  assert.equal(result.kind, "prose");
});

test("unwrap rejects an empty string", () => {
  const result = unwrap("   ");
  assert.equal(result.kind, "empty_string");
});

test("unwrap rejects non-string, non-object values", () => {
  for (const raw of [42, true, null, [1, 2]]) {
    const result = unwrap(raw);
    assert.equal(result.kind, "wrong_type", `expected ${JSON.stringify(raw)} to be wrong_type`);
    assert.deepEqual(result.kind === "wrong_type" ? result.got : undefined, raw);
  }
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test("isCategory accepts every category and rejects everything else", () => {
  // The `as readonly string[]` this used to need is gone: a comparison only
  // needs Category assignable to string, where includes needed the reverse.
  for (const category of ["test_failure", "compile_error", "dependency", "infra", "unknown"]) {
    assert.equal(isCategory(category), true, `${category} should be a category`);
  }
  // flaky is a disposition, not a cause, so it is deliberately not one.
  assert.equal(isCategory("flaky"), false);
  assert.equal(isCategory("cosmic_ray"), false);
  assert.equal(isCategory(42), false);
  assert.equal(isCategory(undefined), false);
});

test("isConfidence rejects out-of-range and non-finite numbers", () => {
  assert.equal(isConfidence(0), true);
  assert.equal(isConfidence(1), true);
  assert.equal(isConfidence(4.2), false);
  assert.equal(isConfidence(-0.1), false);
  assert.equal(isConfidence(Number.NaN), false);
  assert.equal(isConfidence(Number.POSITIVE_INFINITY), false);
  assert.equal(isConfidence("0.9"), false);
});

// ---------------------------------------------------------------------------
// capCause
// ---------------------------------------------------------------------------

test("capCause bounds a long model cause", () => {
  const long = "x".repeat(5_000);
  const capped = capCause(long);
  assert.ok(capped.length < long.length, "cause should be shortened");
  assert.ok(capped.endsWith("…"), "truncation should be visible");
});

test("capCause leaves a short cause alone", () => {
  assert.equal(capCause("short cause"), "short cause");
});

test("capCause collapses a multi-line cause onto one line", () => {
  assert.equal(capCause("first\n  second\n\nthird"), "first second third");
  assert.equal(capCause("already one line"), "already one line");
});

test("capCause bounds a long prose cause, not just a long field", () => {
  const result = toTriage(job("first line\nsecond line"), unwrap("y".repeat(5_000)), 1);
  assert.ok(result.cause.length < 5_000, "prose cause should be bounded");
});

test("a multi-line cause stays inside its bullet", () => {
  // The fixture type promises a one-line cause and the model doesn't always
  // deliver. An unindented second line would end the list item and break the
  // paragraph under it, so this is a markdown bug and not a cosmetic one.
  const result = toTriage(job("FAIL something"), unwrap("First sentence.\nSecond sentence."), 1);
  const body = renderBody([result]);

  assert.match(body, /_in the model's words:_ First sentence\. Second sentence\.\n/);
  for (const line of body.split("\n")) {
    assert.doesNotMatch(line, /^Second sentence/, `a cause line escaped its bullet: ${line}`);
  }
});

// ---------------------------------------------------------------------------
// toTriage
// ---------------------------------------------------------------------------

test("toTriage keeps a good category and cause when confidence is missing", () => {
  // fixtures.ts: typecheck. Field degradation is independent, so a correct
  // compile error survives a missing float.
  const result = toTriage(job("tsc"), unwrap({ category: "compile_error", cause: "Missing type annotation" }), 1);
  assert.equal(isTrusted(result), true);
  assert.equal(result.trust.kind === "trusted" ? result.trust.category : null, "compile_error");
  assert.equal(result.confidence, null);
  assert.equal(result.cause, "Missing type annotation");
});

test("toTriage drops an out-of-range confidence without dropping the diagnosis", () => {
  const result = toTriage(job("tsc"), unwrap({ ...VALID, confidence: 4.2 }), 1);
  assert.equal(result.confidence, null);
  assert.equal(isTrusted(result), true);
  assert.equal(result.trust.kind === "trusted" ? result.trust.category : null, "test_failure");
});

test("toTriage names a missing category", () => {
  const result = toTriage(job("log"), unwrap({ cause: "something", confidence: 0.9 }), 1);
  assert.equal(result.trust.kind === "untrusted" ? result.trust.why.kind : null, "no_category");
  assert.equal(result.trust.kind === "untrusted" ? result.trust.category : null, "unknown");
});

test("toTriage names an unrecognised category by name", () => {
  const result = toTriage(job("log"), unwrap({ category: "cosmic_ray", cause: "x", confidence: 0.9 }), 1);
  const why = result.trust.kind === "untrusted" ? result.trust.why : null;
  assert.equal(why?.kind, "unknown_category");
  assert.equal(why?.kind === "unknown_category" ? why.got : null, "cosmic_ray");
});

test("toTriage falls back to the log headline when there is no cause", () => {
  // A missing cause is a formatting gap, not a trust problem, so this stays
  // trusted. Only an unusable category costs a result its place.
  const result = toTriage(job("eslint .\n1 error"), unwrap({ category: "infra", confidence: 0.7 }), 1);
  assert.equal(result.cause, "eslint .");
  assert.equal(result.causeFromModel, false);
  assert.equal(isTrusted(result), true);
});

test("toTriage handles a job with an empty log", () => {
  const result = toTriage(job(""), unwrap({ category: "infra", confidence: 0.7 }), 1);
  assert.equal(result.cause, "no log was captured for this job");
});

test("toTriage re-routes a flaky verdict instead of degrading it", () => {
  // fixtures.ts: e2e-checkout, which the model called flaky at 0.91 when the
  // log plainly says the database was unreachable. The model returned a
  // well-formed object; it just made a claim one log can't support. So this
  // is a reason, not a broken response, and the model's words are kept.
  const result = toTriage(
    job("connect ECONNREFUSED"),
    unwrap({ category: "flaky", cause: "flaky connection timeout", confidence: 0.91 }),
    1,
  );
  assert.equal(result.trust.kind === "untrusted" ? result.trust.why.kind : null, "suspected_flaky");
  assert.equal(result.causeFromModel, true);
  assert.equal(result.cause, "flaky connection timeout");
});

test("suspected_flaky is only ever set by a flaky claim", () => {
  for (const category of ["test_failure", "compile_error", "dependency", "infra"]) {
    const result = toTriage(job("log"), unwrap({ ...VALID, category }), 1);
    const why = result.trust.kind === "untrusted" ? result.trust.why.kind : null;
    assert.notEqual(why, "suspected_flaky", `${category} should not read as flaky`);
  }
});

test("toTriage records how many model calls it took", () => {
  const firstTry = toTriage(job("log"), unwrap(VALID), 1);
  const onRetry = toTriage(job("log"), unwrap(VALID), 2);
  assert.equal(firstTry.attempts, 1);
  assert.equal(onRetry.attempts, 2);
});

// ---------------------------------------------------------------------------
// isTrusted: the single place that decides whether a result is trustworthy
// enough to lead the comment. Every count in the output comes from it, so the
// headline number and the section it points at can never disagree.
//
// A missing confidence is deliberately NOT counted. No number at all is a
// formatting gap, not a low score, and folding it in would dilute the count
// that's supposed to mean something.
// ---------------------------------------------------------------------------

function triageOf(raw: unknown, log = "first line"): TriageResult {
  return toTriage(job(log), unwrap(raw), 1);
}

test("isTrusted accepts a confident, well-formed classification", () => {
  assert.equal(isTrusted(triageOf(VALID)), true);
});

test("isTrusted rejects a result that is only prose", () => {
  const result = triageOf("just a sentence");
  assert.equal(isTrusted(result), false);
  assert.equal(result.trust.kind === "untrusted" ? result.trust.why.kind : null, "prose");
});

test("isTrusted rejects a model-named unknown even at high confidence", () => {
  // A model can be certain and still have no idea. Confidence doesn't rescue
  // an absent category.
  const result = triageOf({ category: "unknown", cause: "?", confidence: 0.95 });
  assert.equal(isTrusted(result), false);
  assert.equal(result.trust.kind === "untrusted" ? result.trust.why.kind : null, "model_said_unknown");
});

test("isTrusted rejects a model-claimed flaky even at high confidence", () => {
  assert.equal(isTrusted(triageOf({ category: "flaky", cause: "?", confidence: 0.91 })), false);
});

test("isTrusted rejects a low confidence on a real category", () => {
  // fixtures.ts: integration-api.
  const result = triageOf({ category: "test_failure", cause: "x", confidence: 0.2 });
  assert.equal(isTrusted(result), false);
  assert.equal(result.trust.kind === "untrusted" ? result.trust.why.kind : null, "low_confidence");
});

test("isTrusted accepts a missing confidence on a real category", () => {
  // fixtures.ts: typecheck. No number at all is a formatting gap, not a low
  // score. Counting it would dilute the tally that has to mean something.
  assert.equal(isTrusted(triageOf({ category: "compile_error", cause: "x" })), true);
});

test("isTrusted sits exactly on the confidence threshold", () => {
  // The bar lives in trusted() rather than in this predicate, so there is no
  // path that yields a trusted result under it.
  assert.equal(isTrusted(triageOf({ category: "infra", cause: "x", confidence: 0.5 })), true);
  assert.equal(isTrusted(triageOf({ category: "infra", cause: "x", confidence: 0.49 })), false);
});

// ---------------------------------------------------------------------------
// untrustedReason: every sentence the needs-a-human bucket can print, one arm
// per reason. The reasons are facts; this is the only layer that speaks.
// ---------------------------------------------------------------------------

function untrustedWith(why: WhyUntrusted): UntrustedResult {
  return {
    job: job("first line"),
    cause: "the model's words",
    causeFromModel: true,
    confidence: null,
    attempts: 1,
    trust: { kind: "untrusted", category: "unknown", why },
  };
}

test("untrustedReason names a repeated error once", () => {
  const reason = untrustedReason(untrustedWith({ kind: "threw", first: "model request failed (503)", second: "model request failed (503)" }));
  assert.match(reason, /twice with the same error/);
  assert.equal(reason.match(/503/g)?.length, 1, "one 503 is one fact");
});

test("untrustedReason names two different errors separately", () => {
  const reason = untrustedReason(untrustedWith({ kind: "threw", first: "503", second: "timeout" }));
  assert.match(reason, /503/);
  assert.match(reason, /timeout/);
});

test("untrustedReason lists the model's own flaky claim as a claim, not a cause", () => {
  const reason = untrustedReason(untrustedWith({ kind: "suspected_flaky" }));
  assert.match(reason, /one log can't show that/);
});

// ---------------------------------------------------------------------------
// retryingClassify
// ---------------------------------------------------------------------------

test("retryingClassify returns the first success without retrying", async () => {
  let calls = 0;
  const outcome = await retryingClassify(async () => {
    calls += 1;
    return VALID;
  }, "log");
  assert.equal(calls, 1);
  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.kind === "ok" ? outcome.retried : null, false);
});

test("retryingClassify recovers when the first call throws and the retry works", async () => {
  // Not reachable from the fixture data: the only throwing job throws
  // deterministically, so the retry always fails too. This is the branch the
  // "came from the retry" line in the comment describes.
  let calls = 0;
  const outcome = await retryingClassify(async () => {
    calls += 1;
    if (calls === 1) throw new Error("503");
    return VALID;
  }, "log");

  assert.equal(calls, 2);
  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.kind === "ok" ? outcome.retried : null, true);
  assert.deepEqual(outcome.kind === "ok" ? outcome.raw : null, VALID);
});

test("retryingClassify carries both errors when the call fails twice", async () => {
  const outcome = await retryingClassify(async () => {
    throw new Error("model request failed (503)");
  }, "log");
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.kind === "failed" ? outcome.first : null, "model request failed (503)");
  assert.equal(outcome.kind === "failed" ? outcome.second : null, "model request failed (503)");
});

test("retryingClassify keeps two different errors apart", async () => {
  let calls = 0;
  const outcome = await retryingClassify(async () => {
    calls += 1;
    throw new Error(calls === 1 ? "503" : "timeout");
  }, "log");
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.kind === "failed" ? outcome.first : null, "503");
  assert.equal(outcome.kind === "failed" ? outcome.second : null, "timeout");
});

test("retryingClassify survives a thrown non-Error", async () => {
  const outcome = await retryingClassify(async () => {
    throw "just a string";
  }, "log");
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.kind === "failed" ? outcome.first : null, "just a string");
});

// ---------------------------------------------------------------------------
// End to end against the real fixtures. This is the acceptance check: the
// honest count of untrustworthy results is 6, not the 3 the old degraded-only
// split produced. e2e-checkout, unit-utils, and integration-api all carry a
// well-formed classification that we have no reason to act on.
// ---------------------------------------------------------------------------

const ALL_JOB_NAMES_NEEDING_A_HUMAN = [
  "e2e-checkout",
  "integration-api",
  "lint",
  "security-scan",
  "unit-payments",
  "unit-utils",
];

test("all twelve fixture jobs triage, and the count is six", async () => {
  const jobs = await getFailedJobs();
  const results = await Promise.all(jobs.map((j) => triageJob(j, classify)));

  assert.equal(results.length, 12);
  const untrusted = results.filter(isUntrusted).map((r) => r.job.jobName).sort();
  assert.deepEqual(untrusted, ALL_JOB_NAMES_NEEDING_A_HUMAN);
});

test("the confluent high-confidence flaky claim is not trusted", async () => {
  const [result] = await Promise.all([triageJob(job("connect ECONNREFUSED postgres:5432", "e2e-checkout"), classify)]);
  // The fixture calls this flaky at 0.91. The log says the database is
  // unreachable. Neither the model nor a single log can settle it, so it
  // belongs with the results that need a human.
  assert.equal(result.trust.kind === "untrusted" ? result.trust.why.kind : null, "suspected_flaky");
  assert.equal(isTrusted(result), false);
});

test("a call that fails twice is recorded as a thrown call, not as a retry result", async () => {
  // fixtures.ts: lint, the one job that throws. It throws deterministically,
  // so the retry fails too and nothing came back from it. `attempts` is a
  // count, so there is no value here that means "we retried and used it".
  const result = await triageJob(job("eslint .\n/app/src/comment.ts: 1 error\n  no-unused-vars", "lint"), classify);

  assert.equal(isTrusted(result), false);
  assert.equal(result.trust.kind === "untrusted" ? result.trust.why.kind : null, "threw");
  assert.equal(result.attempts, 2);
  assert.equal(result.causeFromModel, false);
  assert.equal(result.cause, "eslint .");
  assert.equal(result.confidence, null);
});

test("a successful first call records one attempt", async () => {
  // fixtures.ts: build-web. One attempt, and a confident compile error.
  const result = await triageJob(job("tsc --noEmit\nsrc/pricing.ts(42,7): error TS2531: Object is possibly 'null'.", "build-web"), classify);
  assert.equal(isTrusted(result), true);
  assert.equal(result.attempts, 1);
});

test("every result has a usable cause and an in-range confidence", async () => {
  const jobs = await getFailedJobs();
  const results = await Promise.all(jobs.map((j) => triageJob(j, classify)));

  for (const result of results) {
    assert.ok(result.cause.length > 0, `${result.job.jobName} has an empty cause`);
    assert.ok(
      result.confidence === null || (result.confidence >= 0 && result.confidence <= 1),
      `${result.job.jobName} has confidence ${result.confidence}`,
    );
  }
});

test("no result is trusted without a category and a cleared confidence bar", async () => {
  // The invariant the union exists to hold. A result the reader has been told
  // is trustworthy must carry a real category, and a trusted one must never
  // sit under the bar.
  const jobs = await getFailedJobs();
  const results = await Promise.all(jobs.map((j) => triageJob(j, classify)));

  for (const result of results) {
    if (isTrusted(result)) {
      assert.notEqual(result.trust.category, "unknown", `${result.job.jobName} is trusted with no category`);
      assert.ok(
        result.confidence === null || result.confidence >= 0.5,
        `${result.job.jobName} is trusted at ${result.confidence}`,
      );
    } else {
      assert.equal(result.trust.category, "unknown", `${result.job.jobName} carries a category but no reason`);
      assert.ok(result.trust.why.kind.length > 0, `${result.job.jobName} is untrusted with no reason`);
    }
  }
});

test("every result's reason survives the trip to the comment", async () => {
  // An untrusted result that renders as a blank row is the failure mode the
  // needs-a-human bucket can't afford. The reason is stored lowercase and
  // capitalized at the render site, so that's the form to look for.
  const jobs = await getFailedJobs();
  const results = await Promise.all(jobs.map((j) => triageJob(j, classify)));
  const body = renderBody(results);

  for (const result of results.filter(isUntrusted)) {
    const reason = untrustedReason(result);
    const rendered = capitalize(reason);
    assert.ok(reason.length > 0, `${result.job.jobName} has an empty reason`);
    assert.ok(body.includes(rendered), `${result.job.jobName}'s reason is missing from the comment`);
  }
});

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("renderBody headlines the same count it lists", async () => {
  const jobs = await getFailedJobs();
  const results = await Promise.all(jobs.map((j) => triageJob(j, classify)));
  const body = renderBody(results);

  const untrusted = results.filter(isUntrusted).length;
  assert.match(body, new RegExp(`^### Needs a human \\(${untrusted}\\)$`, "m"));
  assert.match(body, new RegExp(`${untrusted} of ${results.length} jobs still need a human`));
});

test("renderBody keeps the section count and the headline count in agreement", async () => {
  const jobs = await getFailedJobs();
  const results = await Promise.all(jobs.map((j) => triageJob(j, classify)));
  const body = renderBody(results);

  const sectionCount = Number(/^### Needs a human \((\d+)\)$/m.exec(body)?.[1]);
  const footerCount = Number(/(\d+) of \d+ jobs still need a human\./.exec(body)?.[1]);
  assert.equal(sectionCount, footerCount);
});

test("renderBody never lists a job twice", async () => {
  const jobs = await getFailedJobs();
  const results = await Promise.all(jobs.map((j) => triageJob(j, classify)));
  const body = renderBody(results);

  for (const { jobName } of jobs) {
    const mentions = body.split(`**${jobName}**`).length - 1;
    assert.equal(mentions, 1, `${jobName} appears ${mentions} times`);
  }
});

test("renderBody starts with the marker so the next run can find this comment", async () => {
  const jobs = await getFailedJobs();
  const results = await Promise.all(jobs.map((j) => triageJob(j, classify)));
  assert.match(renderBody(results), /^<!-- ci-triage -->/);
});

test("renderBody survives an empty result set", () => {
  const body = renderBody([]);
  assert.match(body, /^<!-- ci-triage -->/);
  assert.match(body, /0 failed jobs/);
});

test("verdictLine leads with compile errors", async () => {
  const jobs = await getFailedJobs();
  const results = await Promise.all(jobs.map((j) => triageJob(j, classify)));
  const untrusted = results.filter(isUntrusted);
  const trusted = results.filter(isTrusted);

  assert.match(verdictLine(trusted, untrusted), /^Start with \*\*Compile errors\*\*/);
});

test("verdictLine says so plainly when nothing is trustworthy", () => {
  const untrusted = [triageOf("just a sentence")].filter(isUntrusted);
  assert.match(verdictLine([], untrusted), /Nothing came back that I'd trust/);
});

test("verdictLine agrees in the singular", () => {
  const untrusted = [triageOf("just a sentence")].filter(isUntrusted);
  assert.match(verdictLine([], untrusted), /1 of 1 job still needs a human/);
});