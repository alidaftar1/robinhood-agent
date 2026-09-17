import { describe, expect, test } from "bun:test";
import { shouldRetryUnconfirmed as retry } from "@/lib/trade-decision";

// The one decision on the execution path that can spend real money twice.
describe("retry-unconfirmed decision", () => {
  const base = { missingCount: 1, sessionOk: true, verifyComplete: true };

  test("retries only when there is something missing, cleanly placed, fully verified", () => {
    expect(retry(base)).toBe(true);
  });

  test("never retries after an ABORTED place session", () => {
    // An order dispatched to the broker before the abort can land after our order-list read;
    // re-placing it duplicates a real position past the code-computed cap.
    expect(retry({ ...base, sessionOk: false })).toBe(false);
  });

  test("never retries on an INCOMPLETE verification", () => {
    // A partial read cannot prove an order is absent — only that we did not see it.
    expect(retry({ ...base, verifyComplete: false })).toBe(false);
  });

  test("never retries when nothing is missing", () => {
    expect(retry({ ...base, missingCount: 0 })).toBe(false);
  });

  test("every unsafe combination stays false — only the all-clear retries", () => {
    for (const sessionOk of [true, false]) {
      for (const verifyComplete of [true, false]) {
        for (const missingCount of [0, 1, 3]) {
          const expected = missingCount > 0 && sessionOk && verifyComplete;
          expect(retry({ missingCount, sessionOk, verifyComplete })).toBe(expected);
        }
      }
    }
  });
});
