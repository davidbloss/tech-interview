<!-- ci-triage -->

## CI triage: 12 failed jobs

Start with **Compile errors** (2 jobs), the likeliest root cause for the rest. 4 other jobs below. 6 of 12 jobs still need a human, listed at the bottom.

### Compile errors (`compile_error`)

- **build-web** (confidence 0.94)
  Null check missing in src/pricing.ts:42
  [full log](https://ci.example.com/build-web/4821)

  ```
  tsc --noEmit
  src/pricing.ts(42,7): error TS2531: Object is possibly 'null'.
    const next = bid.amount + increment;
  Error: Process completed with exit code 2.
  ```

- **typecheck** (confidence not reported)
  Missing type annotation
  [full log](https://ci.example.com/typecheck/4821)

  ```
  tsc --noEmit
  src/comment.ts(12,3): error TS7006: Parameter 'body' implicitly has an 'any' type.
  ```

### Test failures (`test_failure`)

- **snapshot** (confidence 0.9)
  3 obsolete snapshots in Header.test.tsx
  [full log](https://ci.example.com/snapshot/4821)

  ```
  FAIL src/Header.test.tsx
    3 snapshots obsolete. Run with -u to update.
  ```

- **unit-core** (confidence 0.88)
  Increment rounding: expected 110, got 100
  [full log](https://ci.example.com/unit-core/4821)

  ```
  FAIL src/pricing.test.ts
    ● minimum increment › rounds to previous power of ten
      expected 110 but received 100
      at Object.<anonymous> (src/pricing.test.ts:88:19)
  ```

### Dependency problems (`dependency`)

- **build-mobile** (confidence 0.79)
  Missing module react-native-svg
  [full log](https://ci.example.com/build-mobile/4821)

  ```
  Metro bundler
  Unable to resolve module 'react-native-svg' from App.tsx
    Module not found.
  ```

### Infrastructure (`infra`)

- **deploy-preview** (confidence 0.83)
  Runner ran out of memory (OOM)
  [full log](https://ci.example.com/deploy-preview/4821)

  ```
  Building preview...
  FATAL: JavaScript heap out of memory
    runner killed (OOM)
  ```

### Needs a human (6)

Either the model didn't hand back something usable, or it wasn't confident enough to act on. Open the log; there's no shortcut on these.

- **e2e-checkout** (confidence 0.91)
  The model called this flaky, and one log can't show that. Only a rerun can.
  _in the model's words:_ Looks like a flaky connection timeout — probably retry-able
  [full log](https://ci.example.com/e2e-checkout/4821)

  ```
  Running checkout flow...
  Error: connect ECONNREFUSED postgres:5432
    migration step 014_add_bids failed — database unreachable
  Exit code 1.
  ```

- **unit-utils** (low confidence 0.34)
  The model called this flaky, and one log can't show that. Only a rerun can.
  _in the model's words:_ Retry-timing test; may be a genuine flake
  [full log](https://ci.example.com/unit-utils/4821)

  ```
  FAIL src/retry.test.ts
    ● retry › gives up after N attempts (timeout)
      Exceeded timeout of 5000 ms — passed on rerun
  ```

- **integration-api** (low confidence 0.22)
  The model couldn't name a cause
  _in the model's words:_ Possibly a dependency version mismatch?
  [full log](https://ci.example.com/integration-api/4821)

  ```
  3 requests failed with 500
    POST /bids -> 500
    (no stack captured)
  ```

- **lint**
  The model call failed twice with the same error (model request failed (503))
  [full log](https://ci.example.com/lint/4821)

  ```
  eslint .
  /app/src/comment.ts: 1 error
    no-unused-vars: 'marker' is defined but never used
  ```

- **unit-payments**
  The model wrote a sentence instead of returning the expected shape
  _in the model's words:_ The payments test failed on a null refund.
  [full log](https://ci.example.com/unit-payments/4821)

  ```
  FAIL src/payments.test.ts
    ● refund › issues partial refund
      TypeError: Cannot read properties of undefined (reading 'cents')
  ```

- **security-scan**
  The model returned JSON that was cut off
  [full log](https://ci.example.com/security-scan/4821)

  ```
  npm audit
  1 high severity vulnerability in lodash <4.17.21
  ```

---
_6 of 12 jobs still need a human. Everything above is the model's guess, not a verdict._
