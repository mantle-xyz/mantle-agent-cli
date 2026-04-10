import { getAddress } from "viem";
import registry from "../config/registry.json" with { type: "json" };
const registryData = registry;
export function getRegistryData() {
    return registryData;
}
export function listRegistryEntries(network) {
    // Registry schema keeps legacy "testnet" naming; tool layer exposes "sepolia".
    const environment = network === "sepolia" ? "testnet" : "mainnet";
    return registryData.contracts.filter((entry) => entry.environment === environment);
}
export function findRegistryByAddress(network, address) {
    const normalized = getAddress(address);
    const entries = listRegistryEntries(network);
    for (const entry of entries) {
        if (getAddress(entry.address) === normalized) {
            return entry;
        }
    }
    return null;
}
