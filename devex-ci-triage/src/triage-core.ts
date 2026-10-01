// ---------------------------------------------------------------------------
// The pure core of the CI triage action.
//
// Nothing here touches the filesystem, the network, or the clock, and the
// model call arrives as a parameter. That is the whole point of the split: the
// decisions this file makes, which category a result is and whether the
// reader should believe it, are all testable without a comment store or a
// GitHub token, and src/triage.ts is left holding only the wiring.
//
// Depends on src/fixtures.ts for types alone. Classify and the comment
// primitives are injected by the caller, so importing this module costs no I/O.
// ---------------------------------------------------------------------------

import type { Classification, FailedJob } from "./fixtures.js";

// ---------------------------------------------------------------------------
// Types. TriageResult is the whole contract of this file: every field is
// guaranteed usable, so nothing downstream has to defend against `undefined`
// sneaking into a PR comment.
//
// The split that matters: `Classification` is what the model CLAIMS,
// TriageResult is what we are willing to stand behind. Nothing in the second
// type is allowed to inherit a claim without a reason to doubt it.
//
// Trust is a union member, not a flag. A result is either TrustedResult or
// UntrustedResult and there is no third shape, so a renderer that takes a
// trusted result cannot be handed an untrusted one by accident, and the
// confidence check that decides trust lives in one constructor instead of in a
// helper every caller has to remember.
// ---------------------------------------------------------------------------

// What the model can say, minus `flaky`. A log can't establish flakiness, so
// `flaky` is a disposition rather than a cause and gets its own reason below.
type Category = Exclude<Classification["category"], "flaky">;

// What gets its own section. `unknown` is excluded because it can never be
// trusted, so it lands in the needs-a-human bucket instead of a group.
type GroupedCategory = Exclude<Category, "unknown">;

// Why we won't stand behind a result. Every arm is a fact about what came
// back, never a sentence: untrustedReason turns one into English, in one
// place. Adding an arm here makes the two switches that read it stop
// compiling, which is the point.
type WhyUntrusted =
  | { readonly kind: "threw"; readonly first: string; readonly second: string }
  | { readonly kind: "prose" }
  | { readonly kind: "empty_string" }
  | { readonly kind: "cut_off_by_model" }
  | { readonly kind: "cut_off_by_us" }
  | { readonly kind: "unparseable" }
  | { readonly kind: "wrong_type"; readonly got: unknown }
  | { readonly kind: "no_category" }
  | { readonly kind: "unknown_category"; readonly got: unknown }
  | { readonly kind: "model_said_unknown" }
  | { readonly kind: "suspected_flaky" }
  | { readonly kind: "low_confidence"; readonly got: number };

// Carried by every result, trusted or not, because both renderers read them.
// cause is always one line, always non-empty, always length-capped.
interface TriageFields {
  readonly job: FailedJob;
  readonly cause: string;
  readonly causeFromModel: boolean; // false means we scraped it out of the log
  readonly confidence: number | null; // null = the model gave us no usable number
  readonly attempts: 1 | 2; // how many model calls it took to get here
}

// A trusted result is guaranteed to carry a real category and to have cleared
// the confidence bar. Neither is a property a caller has to check.
type TrustedResult = TriageFields & {
  readonly trust: { readonly kind: "trusted"; readonly category: GroupedCategory };
};

// An untrusted result is guaranteed to carry a reason. There is no such thing
// as an untrusted result whose reason is "no reason".
type UntrustedResult = TriageFields & {
  readonly trust: {
    readonly kind: "untrusted";
    readonly category: "unknown";
    readonly why: WhyUntrusted;
  };
};

type TriageResult = TrustedResult | UntrustedResult;

// The category table. One record answers three questions the file used to ask
// separately, so a category can't get a section without a title or a runtime
// guard without a section.
//
// `satisfies` makes the record exhaustive over GroupedCategory and rejects any
// key that isn't a category, which is the link back to Classification. Without
// it this would be a fresh literal that could drift from the type.
const GROUPS = {
  compile_error: { title: "Compile errors" },
  test_failure: { title: "Test failures" },
  dependency: { title: "Dependency problems" },
  infra: { title: "Infrastructure" },
} as const satisfies Record<GroupedCategory, { readonly title: string }>;

// The ranking. Hand-ordered on purpose: compile errors lead because they block
// everything downstream, and that is a judgement rather than a property of the
// data. The annotation is what keeps the two tables honest about each other.
const GROUP_ORDER: readonly GroupedCategory[] = [
  "compile_error",
  "test_failure",
  "dependency",
  "infra",
];

// The runtime list behind isCategory, so it has to be a value. Derived from
// GROUPS rather than written out again, which is the one cast in this file:
// Object.keys returns string[], and the key check it replaces was a type error
// at every use.
const CATEGORIES = [...Object.keys(GROUPS), "unknown"] as Category[];

const LOW_CONFIDENCE = 0.5;
const EXCERPT_LINES = 6;
const EXCERPT_CHARS = 500;
const CAUSE_CHARS = 200;
const MAX_JSON_SCAN = 8_000;
const MARKER = "<!-- ci-triage -->";

// ---------------------------------------------------------------------------
// Log excerpts. Capped, because a real job log is megabytes and a PR comment
// is not. The first EXCERPT_LINES lines carry the failure in practice: setup
// chatter, then the error.
// ---------------------------------------------------------------------------

function logLines(log: string): string[] {
  return log.split("\n").filter((l) => l.trim().length > 0);
}

function logExcerpt(log: string): string {
  const lines = logLines(log);
  if (lines.length === 0) return "";
  const kept = lines.slice(0, EXCERPT_LINES).join("\n");
  const capped = kept.length > EXCERPT_CHARS ? `${kept.slice(0, EXCERPT_CHARS)}…` : kept;
  return lines.length > EXCERPT_LINES
    ? `${capped}\n… ${lines.length - EXCERPT_LINES} more lines`
    : capped;
}

function logHeadline(log: string): string {
  return (logLines(log)[0] ?? "").trim();
}

// cause is the one field that flows from the model straight into the PR
// comment, so it's the one field that needs a hard bound. Capping it here
// rather than at each source covers all three: the model's cause field, the
// prose fallback, and the log headline.
//
// The newline collapse is not cosmetic. The fixture type promises a one-line
// cause and the model doesn't always deliver, and a cause with a newline in it
// falls out of the bullet it gets rendered inside and breaks the paragraph.
function capCause(text: string): string {
  const oneLine = text.replace(/\s*\n+\s*/g, " ").trim();
  return oneLine.length > CAUSE_CHARS ? `${oneLine.slice(0, CAUSE_CHARS).trimEnd()}…` : oneLine;
}

function causeFromLog(job: FailedJob): string {
  return logHeadline(job.log) || "no log was captured for this job";
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// `some` with `===` rather than `includes`: includes would want a string
// assignable to Category, and the comparison only needs Category assignable
// to string. Same answer, no assertion.
function isCategory(value: unknown): value is Category {
  return typeof value === "string" && CATEGORIES.some((c) => c === value);
}

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

// Every switch over a union in this file ends here, so a new arm is a compile
// error in each of them rather than a silently ignored case. The stack goes in
// because this can only fire after someone adds an arm and forgets, and
// "unhandled triage case: undefined" in a CI log is not something to work out
// from a PR comment.
function assertNever(value: never): never {
  const label = `unhandled triage case: ${JSON.stringify(value)}`;
  const site = new Error().stack?.split("\n").slice(2).join("\n") ?? "call site unavailable";
  console.error(`${label}\n${site}`);
  throw new Error(label);
}

// ---------------------------------------------------------------------------
// Unwrapping. The model may hand back a bare string instead of the object the
// type promises. The pipeline is flat and each stage answers one question:
// is this a string, does it hold JSON, and does that JSON parse.
//
// Each way it can fail is its own variant rather than a free-text note, so the
// trust decision branches on a tag and the wording lives in one place.
//
// It is NOT a loop. JSON.parse is O(n) in input length and always terminates,
// so there is no runaway to bound, and the old depth-3 bound only ever
// produced a failure mode ("JSON nested inside JSON strings") that no real
// model exhibits. Unwrapping still happens once, because double-encoding is a
// real SDK artifact, but once is explicit and its own function call.
// ---------------------------------------------------------------------------

type Unwrapped =
  | { kind: "value"; value: Record<string, unknown> }
  | { kind: "prose"; prose: string }
  | { kind: "wrong_type"; got: unknown }
  | { kind: "empty_string" }
  | { kind: "cut_off_by_model" }
  | { kind: "cut_off_by_us" }
  | { kind: "unparseable" };

function stripFences(text: string): string {
  const fenced = /^[ \t]*```[a-zA-Z0-9]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/.exec(text);
  return (fenced?.[1] ?? text).trim();
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function unwrap(raw: unknown): Unwrapped {
  if (isRecord(raw)) return { kind: "value", value: raw };
  if (typeof raw !== "string") return { kind: "wrong_type", got: raw };
  return unwrapText(raw, 0);
}

// `depth` is a literal union rather than a number so that recursing past one
// re-unwrap is a type error instead of a comment nobody reads.
function unwrapText(input: string, depth: 0 | 1): Unwrapped {
  const unfenced = stripFences(input);
  const window = unfenced.slice(0, MAX_JSON_SCAN);
  const clippedByUs = window.length < unfenced.length;

  if (window === "") return { kind: "empty_string" };

  // Parse the window as it stands before hunting for braces inside it. A
  // JSON-encoded string has its quotes escaped, so slicing between braces
  // first would pull out text like {\"category\":\"infra\"} that can never
  // parse. Parsing first is also what keeps the quotes off a bare category.
  const direct = tryParse(window);
  if (direct.ok) return fromParsed(direct.value, depth);

  // No complete JSON on its own. Look for an object: first `{` to last `}`.
  // A depth counter would close early on a brace inside a string value, so
  // {"cause": "a } b"} would come back unparseable.
  const open = window.indexOf("{");
  if (open === -1) {
    // Nothing that opens an object inside the window. If the response ran
    // past the cap there could still be one out of reach, and that is our
    // doing rather than the model's.
    return clippedByUs ? { kind: "cut_off_by_us" } : { kind: "prose", prose: window };
  }

  // The window is only a ceiling on how much prose we're willing to read, not
  // on how far we follow an object we have already started. Reading to the
  // real closing brace is what keeps a valid answer that begins just under the
  // cap from being thrown away with the rest of the tail.
  const close = unfenced.lastIndexOf("}");
  if (close <= open) return { kind: "cut_off_by_model" };

  const embedded = tryParse(unfenced.slice(open, close + 1));
  if (embedded.ok) return fromParsed(embedded.value, depth);
  return { kind: "unparseable" };
}

function fromParsed(parsed: unknown, depth: 0 | 1): Unwrapped {
  if (typeof parsed === "string") {
    // Double-encoding is a real SDK artifact, so we unwrap it once. Past
    // that we stop: nothing nests deeper in practice, and a loop here would
    // only be a way to invent a failure mode.
    return depth === 0 ? unwrapText(parsed, 1) : { kind: "prose", prose: parsed };
  }
  if (isRecord(parsed)) return { kind: "value", value: parsed };
  return { kind: "wrong_type", got: parsed };
}

// ---------------------------------------------------------------------------
// The trust decision. Three functions and no others: two constructors and one
// reader per value.
//
// Two deliberate choices live here:
//
//   - Fields degrade independently. An object with a good category and cause
//     but no confidence keeps both; we render "confidence not reported"
//     instead of throwing away a correct compile error.
//   - A `flaky` verdict is re-routed, not rejected. The model returned a
//     well-formed object; it just made a claim one log can't support. That's
//     suspected_flaky plus an unknown category, not a degraded result.
// ---------------------------------------------------------------------------

// The fallback shape for a call that gave us nothing to read: the log's first
// line, and nothing claimed by a model.
function logCause(job: FailedJob, attempts: 1 | 2): TriageFields {
  return { job, cause: capCause(causeFromLog(job)), causeFromModel: false, confidence: null, attempts };
}

// The shape for a call that said something in a form we can quote.
function modelCause(job: FailedJob, cause: string, confidence: number | null, attempts: 1 | 2): TriageFields {
  return { job, cause: capCause(cause), causeFromModel: true, confidence, attempts };
}

// The confidence bar lives here rather than in isTrusted, so there is no way
// to construct a trusted result the reader has been told to ignore.
function trusted(fields: TriageFields, category: GroupedCategory): TriageResult {
  const confidence = fields.confidence;
  if (confidence !== null && confidence < LOW_CONFIDENCE) {
    return untrusted(fields, { kind: "low_confidence", got: confidence });
  }
  return { ...fields, trust: { kind: "trusted", category } };
}

function untrusted(fields: TriageFields, why: WhyUntrusted): TriageResult {
  return { ...fields, trust: { kind: "untrusted", category: "unknown", why } };
}

// toTriage: takes whatever came back and returns something the rest of this
// file can render without checking. It no longer decides which kind of
// failure it is looking at: unwrap names the failure, and the caller names the
// retry count, so this function only maps an outcome onto a trust decision.
function toTriage(job: FailedJob, unwrapped: Unwrapped, attempts: 1 | 2): TriageResult {
  switch (unwrapped.kind) {
    case "value":
      return fromValue(job, unwrapped.value, attempts);
    case "prose":
      return untrusted(modelCause(job, unwrapped.prose, null, attempts), { kind: "prose" });
    case "wrong_type":
      return untrusted(logCause(job, attempts), { kind: "wrong_type", got: unwrapped.got });
    case "empty_string":
      return untrusted(logCause(job, attempts), { kind: "empty_string" });
    case "cut_off_by_model":
      return untrusted(logCause(job, attempts), { kind: "cut_off_by_model" });
    case "cut_off_by_us":
      return untrusted(logCause(job, attempts), { kind: "cut_off_by_us" });
    case "unparseable":
      return untrusted(logCause(job, attempts), { kind: "unparseable" });
    default:
      return assertNever(unwrapped);
  }
}

function fromValue(job: FailedJob, value: Record<string, unknown>, attempts: 1 | 2): TriageResult {
  const claimed = typeof value.cause === "string" && value.cause.trim() !== "" ? value.cause.trim() : null;
  const fields: TriageFields = {
    job,
    cause: capCause(claimed ?? causeFromLog(job)),
    causeFromModel: claimed !== null,
    confidence: isConfidence(value.confidence) ? value.confidence : null,
    attempts,
  };

  if (value.category === "flaky") {
    // A log can't establish flakiness, so we don't record it as the cause.
    // We keep what the model said and let the reader judge it.
    return untrusted(fields, { kind: "suspected_flaky" });
  }
  if (isCategory(value.category) && value.category !== "unknown") {
    return trusted(fields, value.category);
  }
  if (value.category === "unknown") {
    return untrusted(fields, { kind: "model_said_unknown" });
  }
  if (value.category === undefined) {
    return untrusted(fields, { kind: "no_category" });
  }
  return untrusted(fields, { kind: "unknown_category", got: value.category });
}

// Both halves are exported rather than only the positive one, so a caller can
// narrow either side of the split. `filter((r) => !isTrusted(r))` looks like it
// should narrow the other arm and doesn't.
function isTrusted(result: TriageResult): result is TrustedResult {
  return result.trust.kind === "trusted";
}

function isUntrusted(result: TriageResult): result is UntrustedResult {
  return result.trust.kind === "untrusted";
}

// ---------------------------------------------------------------------------
// Calling the model. One retry, and only for a thrown error. A 503 is
// transient. Malformed output is not: retrying at the same temperature just
// buys a second of latency and the same garbage, so it goes straight to the
// guard.
//
// The call is a parameter so tests can drive the first-call-fails path, which
// the fixture data can never reach on its own: the one job that throws throws
// deterministically, so the retry always fails too.
// ---------------------------------------------------------------------------

type ModelCall = (log: string) => Promise<unknown>;

// Both errors, not a sentence about both. A repeated 503 is one fact and two
// different errors are two, and untrustedReason is where that difference turns
// into a sentence.
type ClassifyOutcome =
  | { readonly kind: "ok"; readonly raw: unknown; readonly retried: boolean }
  | { readonly kind: "failed"; readonly first: string; readonly second: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function retryingClassify(call: ModelCall, log: string): Promise<ClassifyOutcome> {
  let firstError: string;
  try {
    return { kind: "ok", raw: await call(log), retried: false };
  } catch (error) {
    firstError = errorText(error);
  }

  try {
    return { kind: "ok", raw: await call(log), retried: true };
  } catch (error) {
    return { kind: "failed", first: firstError, second: errorText(error) };
  }
}

async function triageJob(job: FailedJob, call: ModelCall): Promise<TriageResult> {
  const outcome = await retryingClassify(call, job.log);
  return outcome.kind === "ok"
    ? toTriage(job, unwrap(outcome.raw), outcome.retried ? 2 : 1)
    : untrusted(logCause(job, 2), { kind: "threw", first: outcome.first, second: outcome.second });
}

// ---------------------------------------------------------------------------
// Rendering. Every job carries its one-line cause and an excerpt of its log,
// uniformly, so a reader can check the model against the evidence for any
// result without hunting for it.
// ---------------------------------------------------------------------------

function confidenceLabel(result: TriageResult): string {
  if (result.confidence === null) return "confidence not reported";
  if (result.confidence < LOW_CONFIDENCE) return `low confidence ${result.confidence}`;
  return `confidence ${result.confidence}`;
}

function renderExcerpt(log: string, indent: string): string[] {
  const excerpt = logExcerpt(log);
  if (excerpt === "") return [];
  return ["", `${indent}\`\`\``, ...excerpt.split("\n").map((line) => indent + line), `${indent}\`\`\``];
}

// Takes a TrustedResult, so there is no way to render a result as trustworthy
// that isn't. This is the whole reason trust is a union member.
function renderJob(result: TrustedResult): string[] {
  return [
    `- **${result.job.jobName}** (${confidenceLabel(result)})`,
    `  ${result.cause}`,
    ...(result.attempts === 2 ? ["  _the first model call failed, this came from the retry_"] : []),
    `  [full log](${result.job.url})`,
    ...renderExcerpt(result.job.log, "  "),
  ];
}

// Why this row is in the bucket. An unusable row already says what went wrong,
// so it doesn't also need a confidence parenthetical: no call ever succeeded.
function untrustedShowsConfidence(result: UntrustedResult): boolean {
  switch (result.trust.why.kind) {
    case "threw":
    case "prose":
    case "empty_string":
    case "cut_off_by_model":
    case "cut_off_by_us":
    case "unparseable":
    case "wrong_type":
    case "no_category":
    case "unknown_category":
      return false;
    case "model_said_unknown":
    case "suspected_flaky":
    case "low_confidence":
      return true;
    default:
      return assertNever(result.trust.why);
  }
}

// Every sentence the untrusted bucket can print, in one place, one arm per
// reason. Stored lowercase so they compose into sentences elsewhere, but a
// sub-line under a bullet should start like one.
function untrustedReason(result: UntrustedResult): string {
  const why = result.trust.why;
  switch (why.kind) {
    case "threw":
      // A repeated 503 is one fact, not two. Naming it twice reads like the
      // model tried something different and failed differently.
      return why.first === why.second
        ? `the model call failed twice with the same error (${why.first})`
        : `the model call failed, then failed again on retry (${why.first}, then ${why.second})`;
    case "prose":
      return "the model wrote a sentence instead of returning the expected shape";
    case "empty_string":
      return "the model returned an empty string";
    case "cut_off_by_model":
      return "the model returned JSON that was cut off";
    case "cut_off_by_us":
      return "the response was too long for this run to scan";
    case "unparseable":
      return "the model returned JSON that doesn't parse";
    case "wrong_type":
      return `the model returned ${describeType(why.got)}`;
    case "no_category":
      return "the model returned no category";
    case "unknown_category":
      return `the model returned an unrecognised category ${JSON.stringify(why.got)}`;
    case "model_said_unknown":
      return "the model couldn't name a cause";
    case "suspected_flaky":
      return "the model called this flaky, and one log can't show that. Only a rerun can.";
    case "low_confidence":
      return `the model wasn't confident about this (${why.got})`;
    default:
      return assertNever(why);
  }
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

function renderUntrusted(result: UntrustedResult): string[] {
  const label = untrustedShowsConfidence(result) ? ` (${confidenceLabel(result)})` : "";
  return [
    `- **${result.job.jobName}**${label}`,
    `  ${capitalize(untrustedReason(result))}`,
    // Only worth printing when the model actually said something. Otherwise
    // the cause is just the log's first line, and the excerpt below has it.
    ...(result.causeFromModel ? [`  _in the model's words:_ ${result.cause}`] : []),
    `  [full log](${result.job.url})`,
    ...renderExcerpt(result.job.log, "  "),
  ];
}

function byConfidence(a: TriageResult, b: TriageResult): number {
  return (b.confidence ?? -1) - (a.confidence ?? -1);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// "6 of 12 jobs still need a human" / "1 of 12 jobs still needs a human".
// The verb has to agree with the count, which `plural` can't do.
function humanCount(untrusted: number, total: number): string {
  const noun = total === 1 ? "job" : "jobs";
  if (untrusted === 0) return `all ${total} ${noun} classified`;
  return untrusted === 1
    ? `1 of ${total} ${noun} still needs a human`
    : `${untrusted} of ${total} ${noun} still need a human`;
}

function verdictLine(trusted: TrustedResult[], untrusted: UntrustedResult[]): string {
  const lead = GROUP_ORDER.map((category) => ({
    category,
    count: trusted.filter((r) => r.trust.category === category).length,
  })).find((group) => group.count > 0);

  const missed =
    untrusted.length > 0
      ? ` ${humanCount(untrusted.length, trusted.length + untrusted.length)}, listed at the bottom.`
      : "";

  if (lead === undefined) {
    return `Nothing came back that I'd trust.${missed}`;
  }

  const title = GROUPS[lead.category].title;
  const rest = trusted.length - lead.count;
  const tail = rest > 0 ? ` ${plural(rest, "other job")} below.` : "";
  return `Start with **${title}** (${plural(lead.count, "job")}), the likeliest root cause for the rest.${tail}${missed}`;
}

function renderBody(results: TriageResult[]): string {
  const untrusted = results.filter(isUntrusted);
  const trusted = results.filter(isTrusted);

  const out: string[] = [MARKER, ""];
  out.push(`## CI triage: ${plural(results.length, "failed job")}`);
  out.push("");
  out.push(verdictLine(trusted, untrusted));
  out.push("");

  for (const category of GROUP_ORDER) {
    // toSorted rather than sort. The filter already hands us a fresh array,
    // so in-place was never a bug here, but a comparator that sorts in place
    // on whatever it is handed is one refactor away from being one.
    const items = trusted.filter((r) => r.trust.category === category).toSorted(byConfidence);
    if (items.length === 0) continue;

    out.push(`### ${GROUPS[category].title} (\`${category}\`)`);
    out.push("");
    for (const item of items) {
      out.push(...renderJob(item));
      out.push("");
    }
  }

  if (untrusted.length > 0) {
    out.push(`### Needs a human (${untrusted.length})`);
    out.push("");
    out.push(
      "Either the model didn't hand back something usable, or it wasn't confident enough to act on. Open the log; there's no shortcut on these.",
    );
    out.push("");
    // Descending confidence, so the rows where the model guessed wrong but
    // said something readable come first, and the rows where we got nothing
    // at all sit at the bottom as the blind spots.
    for (const item of untrusted.toSorted(byConfidence)) {
      out.push(...renderUntrusted(item));
      out.push("");
    }
  }

  out.push("---");
  out.push(
    untrusted.length > 0
      ? `_${humanCount(untrusted.length, results.length)}. Everything above is the model's guess, not a verdict._`
      : "_Everything above is the model's guess, not a verdict. Check the log before you act on it._",
  );

  return `${out.join("\n").trimEnd()}\n`;
}

function renderEmptyBody(): string {
  return `${MARKER}\n\n## CI triage\n\nNo failed jobs on this run.\n`;
}

// ---------------------------------------------------------------------------
// Everything above is the core's public surface, and nearly all of it is used
// by src/triage.ts for the run itself, or by src/triage.test.ts to drive the
// decisions directly. There is no separate block of test-only exports, because
// the split removed the reason for one. The single exception is
// MAX_JSON_SCAN: a test has to bury a valid answer behind the scan window, and
// a mirrored copy of the number would drift from the constant it is testing.
// ---------------------------------------------------------------------------

export {
  capCause,
  isCategory,
  isConfidence,
  isTrusted,
  isUntrusted,
  MARKER,
  MAX_JSON_SCAN,
  renderBody,
  renderEmptyBody,
  retryingClassify,
  toTriage,
  triageJob,
  untrustedReason,
  unwrap,
  verdictLine,
};
export type {
  Category,
  GroupedCategory,
  ModelCall,
  TriageFields,
  TriageResult,
  TrustedResult,
  UntrustedResult,
  Unwrapped,
  WhyUntrusted,
};