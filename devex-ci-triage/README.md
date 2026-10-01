# CI failure triage

A GitHub Action that reads the failed jobs on a PR, asks a model what broke in each one, and posts a single comment saying what to look at first. It runs on every push and replaces its own comment rather than adding to the pile.

The interesting part isn't posting a comment. It's what happens when the model doesn't cooperate: truncated JSON, a bare sentence instead of the object it promised, a confidence out of range, or a claim the log can't possibly support. The tool keeps going, and it tells the reader how much of it to believe.

**What it produces:** [`example-comment.md`](./example-comment.md), 4,042 characters pasted verbatim from a real run. The exercise brief is in [`EXERCISE.md`](./EXERCISE.md).

## Running it

Node 20+ (it uses `toSorted`; built on 26). No network, no keys, no real CI.

```bash
npm install
npm start        # runs the action, prints the PR comment
npm test         # 60 tests, node:test, no framework
npm run typecheck
npm run reset    # clear the posted comment and start from a clean PR
```

Run `npm start` twice to exercise the update path instead of the create path.

| File | What it holds |
| --- | --- |
| `src/triage-core.ts` | The pure core: unwrapping the response, the trust decision, markdown rendering. Takes the model call as a parameter, so no I/O. |
| `src/triage.ts` | 48 lines of wiring: read jobs, call the model, post one comment. |
| `src/triage.test.ts` | 60 tests. |
| `src/fixtures.ts` | The provided fakes. Untouched. |

Splitting the core out is what lets the decisions worth arguing about be tested without a comment store.

## Tradeoffs

**Trustworthiness is a type, not a flag.** Every result is `TrustedResult` or `UntrustedResult`. `renderJob` accepts a `TrustedResult`, so rendering something we don't trust as though we do is a compile error rather than a reviewer catching it in review. The cost: `category` lives under `trust.category`, and narrowing either way needs a predicate, which is why both `isTrusted` and `isUntrusted` exist.

**The confidence bar lives in the constructor.** `trusted()` checks the threshold and returns an untrusted result if the model is under it, so there's no path that yields a trusted result the reader was told to ignore. A *missing* confidence is deliberately not treated as low: "the model didn't report a number" is a formatting gap, and counting it as a low score would dilute the one number in the comment that's meant to mean something.

**Fields degrade independently.** A good category and cause survive a missing confidence and stay trusted. Dropping a correct compile error over a missing float is the worse failure. The cost is a trusted row that can read "confidence not reported".

**Reasons are tags, not sentences.** `WhyUntrusted` has twelve arms; `untrustedReason` renders one in one place. Adding a reason is a compile error in both switches that read it, so the vocabulary can't drift.

**One retry, only when the call throws.** A 503 is transient; malformed output isn't, and retrying at the same temperature buys latency and the same garbage. Both error messages are kept so the comment can say "failed twice with the same error" rather than presenting one 503 as two facts.

**A `flaky` verdict is re-routed, not rejected.** The model returned a well-formed object; it just made a claim a single log can't support. It becomes `suspected_flaky` with an unknown category, lands in needs-a-human, and the comment says only a rerun settles it. Six of twelve fixture jobs need a human, which is the honest number.

**First `{` to last `}`, not a depth counter.** A depth counter closes early on a brace inside a string, so `{"cause": "a } b"}` reads as unparseable. The mirror cost is that two objects in one response merge into an unparseable blob. String braces are common, two-object responses are rare, so that's the trade. The scan window is a ceiling on how much prose to read, not a wall: an object opening just inside it is followed to its real closing brace past the cap.

## With more time

1. **Cache by log hash.** Every push re-calls the model for every failed job. A re-push that doesn't change a job would cost nothing, which on a busy PR is most calls. Highest value here.
2. **Close the double-comment race.** A failed `updateComment` falls back to `create`, which keeps a run's triage from being lost but doesn't stop two concurrent pushes creating two comments. Real fix is a compare-and-swap, or keying the comment on the head SHA.
3. **A concurrency pool and a per-call timeout.** `Promise.all` is right for 12 jobs and wrong for 1,200. The timeout is the actual gap: one hung call hangs the run, and a timeout should count as a throw.
4. **Structured output at the source.** Most of the unwrapping exists because the provider's JSON mode isn't reliable enough to bet on. With a schema or tool-call mode it collapses to a guard that rarely fires. I'd keep the guard and delete the rest.
5. **Give flakiness evidence.** The tool correctly says a log can't show a test is flaky. It could look at the last N pushes and notice a job failing and passing repeatedly, which makes `flaky` a category with something behind it.
6. **Extract the error, not the first six lines.** The excerpt is the log head, which works for these fixtures and wouldn't for a real Jest run where the assertion is 9,000 lines down. Per-category extractors would be the fix.
7. **Calibrate the threshold.** `LOW_CONFIDENCE = 0.5` is a guess. A labeled set of failures would show where it belongs, and whether the model's confidence correlates with correctness at all.

## Left out on purpose

- **No dependencies.** `node:test` and `tsx` were already here; adding a framework would be noise.
- **No timeouts, cancellation, or backoff** on the model call.
- **No comment-size ceiling.** Fields are capped, but 300 jobs would still exceed GitHub's 65,536-character limit. Truncation belongs at the comment level.
- **No dedup.** Identical logs get classified and listed twice.
- **No prompt or model version** in the output, so nothing says which prompt produced a verdict.
- **No structured logging.** The comment is the only output; a real action emits timings and call counts.
- **`fixtures.ts` untouched**, including the `as Classification` cast that hides the lie from the type system. That cast is what the `unknown`-and-guard approach is built to survive, so it's load-bearing.
- **Two tsconfig lines** so the code is honest about the runtime: `lib: ES2023` for `toSorted`, `erasableSyntaxOnly` to rule out enums. `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` stay off; both would flag the provided scaffolding rather than my code.

## Limitations

The weakest claim in the comment is "the likeliest root cause for the rest". That's a category frequency count, not causality, and two compile errors in unrelated packages are two bugs rather than one. The comment currently reads as if the first section explains the others.

`attempts` is recorded but only rendered on trusted rows, so a reader can't distinguish a retried-and-failed row from a first-try failure.

And whether any of this helps anyone, I have no data. Everything above is about the output being defensible, not about it being useful.
