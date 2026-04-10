import { CHAIN_CONFIGS } from "./config/chains.js";
import { getRegistryData } from "./lib/registry.js";
import { readSkillsReference } from "./lib/skills-path.js";
import { MANTLE_TOKENS } from "./config/tokens.js";
import { MANTLE_PROTOCOLS } from "./config/protocols.js";
import { capabilityCatalog } from "./capability-catalog.js";
const RESOURCES = [
    {
        uri: "mantle://chain/mainnet",
        name: "Mantle Mainnet Configuration",
        description: "Static chain configuration for Mantle mainnet.",
        mimeType: "application/json"
    },
    {
        uri: "mantle://chain/sepolia",
        name: "Mantle Sepolia Testnet Configuration",
        description: "Static chain configuration for Mantle Sepolia.",
        mimeType: "application/json"
    },
    {
        uri: "mantle://registry/contracts",
        name: "Mantle Verified Contract Registry",
        description: "Curated contract registry for address resolution workflows.",
        mimeType: "application/json"
    },
    {
        uri: "mantle://registry/tokens",
        name: "Mantle Token Registry",
        description: "Embedded quick-reference token list for Mantle networks.",
        mimeType: "application/json"
    },
    {
        uri: "mantle://registry/protocols",
        name: "Mantle DeFi Protocol Registry",
        description: "Protocol metadata for enabled and planned Mantle integrations.",
        mimeType: "application/json"
    },
    {
        uri: "mantle://docs/network-basics",
        name: "Mantle Network Basics",
        description: "Network fundamentals from mantle-network-primer references.",
        mimeType: "text/markdown"
    },
    {
        uri: "mantle://docs/risk-checklist",
        name: "Transaction Risk Checklist",
        description: "Pre-execution risk checklist from mantle-risk-evaluator references.",
        mimeType: "text/markdown"
    },
    {
        uri: "mantle://registry/capabilities",
        name: "Mantle Tool Capability Catalog",
        description: "Structured catalog of all MCP tools with semantic classification (query/analyze/execute), " +
            "read/write nature, wallet requirements, and usage examples. " +
            "Use this to quickly find the right tool for a task.",
        mimeType: "application/json"
    }
];
export function listResources() {
    return RESOURCES;
}
export function readResource(uri) {
    if (uri === "mantle://chain/mainnet") {
        return {
            content: JSON.stringify(CHAIN_CONFIGS.mainnet, null, 2),
            mimeType: "application/json"
        };
    }
    if (uri === "mantle://chain/sepolia") {
        return {
            content: JSON.stringify(CHAIN_CONFIGS.sepolia, null, 2),
            mimeType: "application/json"
        };
    }
    if (uri === "mantle://registry/contracts") {
        return {
            content: JSON.stringify(getRegistryData(), null, 2),
            mimeType: "application/json"
        };
    }
    if (uri === "mantle://registry/tokens") {
        return {
            content: JSON.stringify(MANTLE_TOKENS, null, 2),
            mimeType: "application/json"
        };
    }
    if (uri === "mantle://registry/protocols") {
        return {
            content: JSON.stringify(MANTLE_PROTOCOLS, null, 2),
            mimeType: "application/json"
        };
    }
    if (uri === "mantle://docs/network-basics") {
        return {
            content: readSkillsReference("skills/mantle-network-primer/references/mantle-network-basics.md"),
            mimeType: "text/markdown"
        };
    }
    if (uri === "mantle://docs/risk-checklist") {
        return {
            content: readSkillsReference("skills/mantle-risk-evaluator/references/risk-checklist.md"),
            mimeType: "text/markdown"
        };
    }
    if (uri === "mantle://registry/capabilities") {
        return {
            content: JSON.stringify(capabilityCatalog(), null, 2),
            mimeType: "application/json"
        };
    }
    return null;
}
export async function prefetchResources() {
    return Promise.resolve();
}
