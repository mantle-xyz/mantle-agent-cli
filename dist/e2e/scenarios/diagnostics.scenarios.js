export const diagnosticsScenarios = [
    {
        id: "diagnostics-checkRpcHealth-mainnet",
        module: "diagnostics",
        toolName: "mantle_checkRpcHealth",
        prompt: "Check the health of the Mantle mainnet RPC endpoint.",
        expectedToolCall: "mantle_checkRpcHealth",
        expectedOutcome: "success",
        outputAssertions: {
            requiredArgs: [],
            toolArgsMatch: { network: "mainnet" },
            containsAnyText: ["reachable", "chain_id"]
        }
    },
    {
        id: "diagnostics-probeEndpoint-block",
        module: "diagnostics",
        toolName: "mantle_probeEndpoint",
        prompt: "Probe the RPC endpoint https://rpc.mantle.xyz with eth_blockNumber.",
        expectedToolCall: "mantle_probeEndpoint",
        expectedOutcome: "success",
        outputAssertions: {
            requiredArgs: ["rpc_url"],
            toolArgsMatch: {
                rpc_url: "https://rpc.mantle.xyz",
                method: "eth_blockNumber"
            },
            containsAnyText: ["result", "block"]
        }
    }
];
