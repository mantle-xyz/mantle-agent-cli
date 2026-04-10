export const chainScenarios = [
    {
        id: "chain-getChainInfo-mainnet",
        module: "chain",
        toolName: "mantle_getChainInfo",
        prompt: "What is Mantle's chain ID and native gas token on mainnet?",
        expectedToolCall: "mantle_getChainInfo",
        expectedOutcome: "success",
        outputAssertions: {
            requiredArgs: [],
            toolArgsMatch: { network: "mainnet" },
            containsText: ["5000", "MNT"]
        }
    },
    {
        id: "chain-getChainStatus-mainnet",
        module: "chain",
        toolName: "mantle_getChainStatus",
        prompt: "What is the latest block number on Mantle mainnet?",
        expectedToolCall: "mantle_getChainStatus",
        expectedOutcome: "success",
        outputAssertions: {
            requiredArgs: [],
            toolArgsMatch: { network: "mainnet" },
            containsText: ["block"]
        }
    }
];
