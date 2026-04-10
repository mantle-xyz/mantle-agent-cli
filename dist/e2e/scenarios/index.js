import { accountScenarios } from "./account.scenarios.js";
import { chainScenarios } from "./chain.scenarios.js";
import { defiReadScenarios } from "./defi-read.scenarios.js";
import { diagnosticsScenarios } from "./diagnostics.scenarios.js";
import { indexerScenarios } from "./indexer.scenarios.js";
import { registryScenarios } from "./registry.scenarios.js";
import { tokenScenarios } from "./token.scenarios.js";
export const allScenarios = [
    ...chainScenarios,
    ...registryScenarios,
    ...accountScenarios,
    ...tokenScenarios,
    ...defiReadScenarios,
    ...indexerScenarios,
    ...diagnosticsScenarios
];
