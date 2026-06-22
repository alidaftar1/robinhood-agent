/**
 * Eval runners for both layers of the production architecture:
 *
 * 1. runAnalysisAgent — tests the Sonnet analysis session (buildAnalysisPrompt).
 *    No tool calls; validates TRADE_DECISION JSON output.
 *
 * 2. runMockAgent — tests the Haiku execution session (buildSystemPrompt).
 *    Replaces the real Robinhood MCP with local mock tools.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Scenario } from "./fixtures";
import { SP500_UNIVERSE } from "@/lib/strategy";

// ─── Analysis session runner ───────────────────────────────────────────────────

export interface TradeDecision {
  thesis: string;
  sells: Array<{ symbol: string; quantity: number }>;
  buys: Array<{ symbol: string; quantity: number; price: number }>;
}

export interface AnalysisResult {
  text: string;
  decision: TradeDecision | null;
}

export async function runAnalysisAgent(systemPrompt: string): Promise<AnalysisResult> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3 });
  const resp = await (anthropic.messages as any).create({
    model: "claude-sonnet-4-6",
    max_tokens: 3000,
    system: systemPrompt,
    messages: [{ role: "user", content: "Analyze and decide. Output your thesis then the TRADE_DECISION line." }],
  });
  const text = resp.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");

  const match = text.match(/^TRADE_DECISION:(.+)$/m);
  let decision: TradeDecision | null = null;
  if (match) {
    try { decision = JSON.parse(match[1]); } catch { /* invalid JSON */ }
  }
  return { text, decision };
}

const ACCOUNT = process.env.AGENTIC_ACCOUNT_ID ?? "";

// ─── Mock tool schemas ────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_equity_positions",
    description: "List open equity positions for a brokerage account.",
    input_schema: {
      type: "object" as const,
      properties: {
        account_number: { type: "string" },
      },
      required: ["account_number"],
    },
  },
  {
    name: "get_portfolio",
    description: "Get portfolio market value and buying power.",
    input_schema: {
      type: "object" as const,
      properties: {
        account_number: { type: "string" },
      },
      required: ["account_number"],
    },
  },
  {
    name: "place_equity_order",
    description: "Place a market buy or sell order.",
    input_schema: {
      type: "object" as const,
      properties: {
        account_number: { type: "string" },
        symbol:         { type: "string" },
        side:           { type: "string", enum: ["buy", "sell"] },
        type:           { type: "string" },
        quantity:       { type: "number" },
        time_in_force:  { type: "string" },
      },
      required: ["account_number", "symbol", "side", "type", "quantity"],
    },
  },
  // Include forbidden tools so we can detect if Claude calls them.
  {
    name: "get_equity_quotes",
    description: "Get real-time quotes for symbols.",
    input_schema: {
      type: "object" as const,
      properties: { symbols: { type: "array", items: { type: "string" } } },
      required: ["symbols"],
    },
  },
  {
    name: "get_equity_tradability",
    description: "Check whether a symbol is tradeable.",
    input_schema: {
      type: "object" as const,
      properties: {
        account_number: { type: "string" },
        symbol:         { type: "string" },
      },
      required: ["account_number", "symbol"],
    },
  },
  {
    name: "review_equity_order",
    description: "Preview an order before placing it.",
    input_schema: {
      type: "object" as const,
      properties: {
        account_number: { type: "string" },
        symbol:         { type: "string" },
        side:           { type: "string" },
        quantity:       { type: "number" },
      },
      required: ["account_number", "symbol", "side", "quantity"],
    },
  },
];

// ─── Mock tool responses ──────────────────────────────────────────────────────

function mockResponse(toolName: string, input: Record<string, unknown>, scenario: Scenario): string {
  switch (toolName) {
    case "get_equity_positions":
      return JSON.stringify({
        data: {
          positions: scenario.positions.map((p) => ({
            symbol: p.symbol,
            quantity: p.quantity,
            intraday_quantity: p.quantity,
            average_buy_price: p.average_buy_price,
            shares_available_for_sells: p.quantity,
            type: "long",
          })),
        },
        guide: "Use shares_available_for_sells for sells. average_buy_price is your cost basis.",
      });

    case "get_portfolio":
      return JSON.stringify({
        data: {
          total_value: scenario.totalValue.replace("$", ""),
          cash: scenario.buyingPower.replace("$", ""),
          buying_power: {
            buying_power: scenario.buyingPower.replace("$", ""),
            display_currency: "USD",
          },
        },
      });

    case "place_equity_order": {
      const sym = String(input.symbol ?? "");
      const side = String(input.side ?? "");
      const qty = Number(input.quantity ?? 0);
      return JSON.stringify({
        data: {
          id: `mock-${Date.now()}`,
          symbol: sym,
          side,
          type: "market",
          quantity: String(qty),
          state: "confirmed",
          placed_agent: "agentic",
        },
      });
    }

    case "get_equity_quotes": {
      const symbols = (input.symbols as string[]) ?? [];
      return JSON.stringify({
        data: symbols.map((s) => ({ symbol: s, ask_price: "100.00", bid_price: "99.90" })),
      });
    }

    case "get_equity_tradability":
      return JSON.stringify({
        data: {
          symbol: input.symbol,
          is_tradeable: SP500_UNIVERSE.includes(String(input.symbol ?? "")),
        },
      });

    case "review_equity_order":
      return JSON.stringify({ data: { estimated_price: "100.00", review: "Order looks valid." } });

    default:
      return JSON.stringify({ error: "Unknown tool" });
  }
}

// ─── Tool call record ─────────────────────────────────────────────────────────

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

export interface AgentRunResult {
  toolCalls: ToolCall[];
  finalSummary: string;
  turnCount: number;
}

// ─── Agentic loop ─────────────────────────────────────────────────────────────

export async function runMockAgent(
  systemPrompt: string,
  scenario: Scenario,
  options: { maxTurns?: number } = {}
): Promise<AgentRunResult> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 5 });
  const maxTurns = options.maxTurns ?? 20;

  const toolCalls: ToolCall[] = [];
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        "Execute today's trading strategy. Your portfolio state and current prices are already provided above — do NOT call get_equity_positions, get_portfolio, or get_equity_quotes. Go directly to analysis, then place orders with place_equity_order.",
    },
  ];

  let turnCount = 0;

  while (turnCount < maxTurns) {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    turnCount++;

    if (response.stop_reason === "end_turn") {
      const finalSummary = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { toolCalls, finalSummary, turnCount };
    }

    // Collect tool calls and build results
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => {
      const input = block.input as Record<string, unknown>;
      toolCalls.push({ tool: block.name, input });
      return {
        type: "tool_result" as const,
        tool_use_id: block.id,
        content: mockResponse(block.name, input, scenario),
      };
    });

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  // Ran out of turns — return what we have
  const finalSummary = messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Anthropic.ContentBlock[])
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
        : []
    )
    .join("\n");

  return { toolCalls, finalSummary, turnCount };
}
