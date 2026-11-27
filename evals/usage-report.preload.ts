// Loaded with `bun test --preload` by the LLM eval runs (package.json test:llm, evals-llm.yml).
// A hook in a preload file runs once for the whole run, after every test file — so this prints the
// run's total model spend (lib/llm-usage in-memory tally) exactly once.
import { afterAll } from "bun:test";
import { memoryTally, formatTally } from "@/lib/llm-usage";

afterAll(() => console.log(`\n${formatTally(memoryTally())}`));
