export const tokenScenarios = [
    {
        id: "token-getTokenInfo-usdc",
        module: "token",
        toolName: "mantle_getTokenInfo",
        prompt: "What are the details of the USDC token on Mantle, including its decimals and address?",
        expectedToolCall: "mantle_getTokenInfo",
        expectedOutcome: "success",
        outputAssertions: {
            requiredArgs: ["token"],
            toolArgsMatch: { token: "USDC" },
            containsAnyText: ["usdc", "decimals"]
        }
    },
    {
        id: "token-resolveToken-meth",
        module: "token",
        toolName: "mantle_resolveToken",
        prompt: "Resolve the mETH token on Mantle and return the quick-reference result. Set require_token_list_match=false for this check.",
        expectedToolCall: "mantle_resolveToken",
        expectedOutcome: "success",
        outputAssertions: {
            requiredArgs: ["symbol", "require_token_list_match"],
            toolArgsMatch: { symbol: "mETH", require_token_list_match: false },
            containsText: ["meth"]
        }
    },
    {
        id: "token-getTokenPrices-multi",
        module: "token",
        toolName: "mantle_getTokenPrices",
        prompt: "Get the current USD prices for USDC and WMNT on Mantle.",
        expectedToolCall: "mantle_getTokenPrices",
        expectedOutcome: "success",
        outputAssertions: {
            requiredArgs: ["tokens"],
            toolArgsMatch: { tokens: ["USDC", "WMNT"] },
            containsAnyText: ["price", "null"]
        }
    }
];
