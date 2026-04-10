import { MantleMcpError } from "../errors.js";
const NETWORKS = new Set(["mainnet", "sepolia"]);
export function normalizeNetwork(args, options) {
    const warnings = [];
    const allowLegacyEnvironment = options?.allowLegacyEnvironment ?? false;
    let rawNetwork = args.network;
    if (rawNetwork == null && allowLegacyEnvironment) {
        rawNetwork = args.environment;
    }
    const normalized = (typeof rawNetwork === "string" ? rawNetwork : "mainnet").toLowerCase();
    let networkValue = normalized;
    if (allowLegacyEnvironment && normalized === "testnet") {
        networkValue = "sepolia";
        warnings.push("'testnet' is deprecated; use 'sepolia'.");
    }
    if (!NETWORKS.has(networkValue)) {
        throw new MantleMcpError("UNSUPPORTED_NETWORK", `Unsupported network: ${String(rawNetwork ?? "unknown")}`, "Use one of: mainnet, sepolia.", { network: rawNetwork ?? null });
    }
    return { network: networkValue, warnings };
}
