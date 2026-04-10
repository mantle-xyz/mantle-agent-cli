export const indexerScenarios = [
    {
        id: "indexer-querySubgraph-basic",
        module: "indexer",
        toolName: "mantle_querySubgraph",
        prompt: "Query the Agni subgraph at {E2E_SUBGRAPH_ENDPOINT} to get the top 5 pools by TVL. Use the GraphQL query: { pools(first: 5, orderBy: totalValueLockedUSD) { id totalValueLockedUSD } }",
        expectedToolCall: "mantle_querySubgraph",
        expectedOutcome: "success",
        skipUnless: "E2E_SUBGRAPH_ENDPOINT",
        outputAssertions: {
            requiredArgs: ["endpoint", "query"],
            toolArgsMatch: { endpoint: "{E2E_SUBGRAPH_ENDPOINT}" },
            containsAnyText: ["data", "pool"]
        }
    },
    {
        id: "indexer-queryIndexerSql-basic",
        module: "indexer",
        toolName: "mantle_queryIndexerSql",
        prompt: "Run a SQL query against the indexer at {E2E_SQL_ENDPOINT} to get the top 10 token transfers: SELECT * FROM transfers ORDER BY block_number DESC LIMIT 10",
        expectedToolCall: "mantle_queryIndexerSql",
        expectedOutcome: "success",
        skipUnless: "E2E_SQL_ENDPOINT",
        outputAssertions: {
            requiredArgs: ["endpoint", "query"],
            toolArgsMatch: { endpoint: "{E2E_SQL_ENDPOINT}" },
            containsAnyText: ["columns", "rows"]
        }
    }
];
