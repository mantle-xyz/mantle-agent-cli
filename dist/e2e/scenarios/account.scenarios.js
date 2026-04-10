const SAMPLE_ADDRESS = "0x458F293454fE0d67EC0655f3672301301DD51422";
export const accountScenarios = [
    {
        id: "account-getBalance-sample",
        module: "account",
        toolName: "mantle_getBalance",
        prompt: `Check the MNT balance of address ${SAMPLE_ADDRESS} on Mantle mainnet.`,
        expectedToolCall: "mantle_getBalance",
        expectedOutcome: "success",
        outputAssertions: {
            requiredArgs: ["address"],
            toolArgsMatch: { address: SAMPLE_ADDRESS },
            containsAnyText: ["balance", "mnt"]
        }
    },
    {
        id: "account-getTokenBalances-multi",
        module: "account",
        toolName: "mantle_getTokenBalances",
        prompt: `Show the USDC and WETH token balances for ${SAMPLE_ADDRESS} on Mantle.`,
        expectedToolCall: "mantle_getTokenBalances",
        expectedOutcome: "success",
        outputAssertions: {
            requiredArgs: ["address", "tokens"],
            toolArgsMatch: { address: SAMPLE_ADDRESS },
            containsText: ["balance"]
        }
    },
    {
        id: "account-getAllowances-agni",
        module: "account",
        toolName: "mantle_getAllowances",
        prompt: "Check the USDC allowance that 0x458F293454fE0d67EC0655f3672301301DD51422 has granted to the Agni Router 0x319B69888b0d11cEC22caA5034e25FfFBDc88421.",
        expectedToolCall: "mantle_getAllowances",
        expectedOutcome: "success",
        outputAssertions: {
            requiredArgs: ["owner", "pairs"],
            toolArgsMatch: { owner: SAMPLE_ADDRESS },
            containsText: ["allowance"]
        }
    }
];
