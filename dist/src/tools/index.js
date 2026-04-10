import { accountTools } from "./account.js";
import { chainTools } from "./chain.js";
import { defiReadTools } from "./defi-read.js";
import { defiLpReadTools } from "./defi-lp-read.js";
import { defiWriteTools } from "./defi-write.js";
import { diagnosticsTools } from "./diagnostics.js";
import { indexerTools } from "./indexer.js";
import { registryTools } from "./registry.js";
import { tokenTools } from "./token.js";
export { accountTools } from "./account.js";
export { chainTools } from "./chain.js";
export { defiReadTools } from "./defi-read.js";
export { defiLpReadTools } from "./defi-lp-read.js";
export { defiWriteTools } from "./defi-write.js";
export { diagnosticsTools } from "./diagnostics.js";
export { indexerTools } from "./indexer.js";
export { registryTools } from "./registry.js";
export { tokenTools } from "./token.js";
const toolList = [
    ...Object.values(chainTools),
    ...Object.values(registryTools),
    ...Object.values(accountTools),
    ...Object.values(tokenTools),
    ...Object.values(defiReadTools),
    ...Object.values(defiLpReadTools),
    ...Object.values(defiWriteTools),
    ...Object.values(indexerTools),
    ...Object.values(diagnosticsTools)
];
export const allTools = Object.fromEntries(toolList.map((tool) => [tool.name, tool]));
