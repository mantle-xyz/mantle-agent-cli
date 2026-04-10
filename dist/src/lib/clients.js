import { createPublicClient, http, defineChain } from "viem";
import { CHAIN_CONFIGS } from "../config/chains.js";
/**
 * Mantle chain definitions for viem — needed for multicall support.
 * multicall3 is deployed at the canonical address on both networks.
 */
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const mantleMainnet = defineChain({
    id: 5000,
    name: "Mantle",
    nativeCurrency: { name: "MNT", symbol: "MNT", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.mantle.xyz/"] } },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } }
});
const mantleSepolia = defineChain({
    id: 5003,
    name: "Mantle Sepolia",
    nativeCurrency: { name: "MNT", symbol: "MNT", decimals: 18 },
    rpcUrls: { default: { http: ["https://sepolia.mantle.xyz:13000/"] } },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } }
});
const clientCache = new Map();
export function getRpcUrl(network) {
    if (network === "mainnet") {
        return process.env.MANTLE_RPC_URL ?? CHAIN_CONFIGS.mainnet.rpc_url;
    }
    return process.env.MANTLE_SEPOLIA_RPC_URL ?? CHAIN_CONFIGS.sepolia.rpc_url;
}
export function getPublicClient(network) {
    const cached = clientCache.get(network);
    if (cached) {
        return cached;
    }
    const client = createPublicClient({
        chain: network === "mainnet" ? mantleMainnet : mantleSepolia,
        transport: http(getRpcUrl(network))
    });
    clientCache.set(network, client);
    return client;
}
