export const registryScenarios = [
    {
        id: "registry-resolveAddress-usdc",
        module: "registry",
        toolName: "mantle_resolveAddress",
        prompt: "What is the contract address for USDC on Mantle?",
        expectedToolCall: "mantle_resolveAddress",
        expectedOutcome: "success",
        outputAssertions: {
            requiredArgs: ["identifier"],
            toolArgsMatch: { identifier: "USDC" },
            containsText: ["0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9"]
        }
    },
    {
        id: "registry-validateAddress-wmnt",
        module: "registry",
        toolName: "mantle_validateAddress",
        prompt: "Validate the address 0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8 on Mantle.",
        expectedToolCall: "mantle_validateAddress",
        expectedOutcome: "success",
        outputAssertions: {
            requiredArgs: ["address"],
            toolArgsMatch: { address: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8" },
            containsAnyText: ["valid", "wmnt"]
        }
    }
];
