import { InvalidArgumentError } from "commander";
import { MantleMcpError } from "../src/errors.js";
export function parseCommaList(value) {
    return value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}
export function parseJsonString(value, fieldName) {
    try {
        const parsed = JSON.parse(value);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("Expected a JSON object");
        }
        return parsed;
    }
    catch {
        throw new MantleMcpError("INVALID_INPUT", `${fieldName} must be valid JSON object.`, `Provide ${fieldName} as a JSON string, e.g. '{"key":"value"}'.`, { field: fieldName, value });
    }
}
export function applyRpcOverride(rpcUrl, network) {
    if (!rpcUrl)
        return;
    if (network === "sepolia") {
        process.env.MANTLE_SEPOLIA_RPC_URL = rpcUrl;
    }
    else {
        process.env.MANTLE_RPC_URL = rpcUrl;
    }
}
export function parseJsonArray(value, fieldName) {
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) {
            throw new Error("Expected a JSON array");
        }
        return parsed;
    }
    catch {
        throw new MantleMcpError("INVALID_INPUT", `${fieldName} must be a valid JSON array.`, `Provide ${fieldName} as a JSON string, e.g. '[1, "0x..."]'.`, { field: fieldName, value });
    }
}
export function parseIntegerOption(value, optionName) {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
        throw new InvalidArgumentError(`${optionName} must be a valid integer.`);
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed)) {
        throw new InvalidArgumentError(`${optionName} must be a safe integer.`);
    }
    return parsed;
}
export function parseNumberOption(value, optionName) {
    const trimmed = value.trim();
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
        throw new InvalidArgumentError(`${optionName} must be a valid number.`);
    }
    return parsed;
}
