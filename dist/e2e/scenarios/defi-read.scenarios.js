export const defiReadScenarios = [
    {
        id: "defi-getSwapQuote-agni",
        module: "defi-read",
        toolName: "mantle_getSwapQuote",
        prompt: "Get me a swap quote for 100 USDC to USDT on Agni on Mantle.",
        expectedToolCall: "mantle_getSwapQuote",
        expectedOutcome: "tool-error",
        outputAssertions: {
            requiredArgs: ["token_in", "token_out", "amount_in"],
            toolArgsMatch: { token_in: "USDC", token_out: "USDT", amount_in: "100" },
            containsAnyText: ["no_route", "no route", "error"]
        }
    },
    {
        id: "defi-getPoolLiquidity-pool",
        module: "defi-read",
        toolName: "mantle_getPoolLiquidity",
        prompt: "Show the liquidity details of the Agni pool at address 0x1234567890abcdef1234567890abcdef12345678 on Mantle.",
        expectedToolCall: "mantle_getPoolLiquidity",
        expectedOutcome: "tool-error",
        outputAssertions: {
            requiredArgs: ["pool_address"],
            toolArgsMatch: { pool_address: "0x1234567890abcdef1234567890abcdef12345678" },
            containsAnyText: ["pool_not_found", "not found", "error"]
        }
    },
    {
        id: "defi-getLendingMarkets-aave",
        module: "defi-read",
        toolName: "mantle_getLendingMarkets",
        prompt: "Show me the Aave v3 lending markets on Mantle, especially for USDC.",
        expectedToolCall: "mantle_getLendingMarkets",
        expectedOutcome: "success",
        outputAssertions: {
            requiredArgs: [],
            toolArgsMatchAny: [{ protocol: "aave_v3" }, { asset: "USDC" }],
            containsAnyText: ["market", "aave", "empty"]
        }
    },
    {
        id: "defi-getProtocolTvl-agni",
        module: "defi-read",
        toolName: "mantle_getProtocolTvl",
        prompt: "Get the latest TVL overview across all supported protocols on Mantle.",
        expectedToolCall: "mantle_getProtocolTvl",
        expectedOutcome: "success",
        outputAssertions: {
            requiredArgs: [],
            containsAnyText: ["tvl", "source_trace", "breakdown"]
        }
    },
    {
        id: "defi-getPoolOpportunities-mnt-meth",
        module: "defi-read",
        toolName: "mantle_getPoolOpportunities",
        prompt: "I have MNT and mETH. Find candidate pools on Mantle and rank them.",
        expectedToolCall: "mantle_getPoolOpportunities",
        expectedOutcome: "tool-error",
        outputAssertions: {
            requiredArgs: ["token_a", "token_b"],
            toolArgsMatchAny: [{ token_a: "MNT", token_b: "mETH" }, { token_a: "WMNT", token_b: "mETH" }],
            containsAnyText: ["no_route", "no matching liquidity", "error"]
        }
    }
];
