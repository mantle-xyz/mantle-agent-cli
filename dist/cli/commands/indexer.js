import { allTools } from "../../src/tools/index.js";
import { formatTable, formatJson, formatKeyValue } from "../formatter.js";
import { parseIntegerOption, parseJsonString } from "../utils.js";
export function registerIndexer(parent) {
    const group = parent.command("indexer").description("Subgraph and SQL queries");
    group
        .command("subgraph")
        .description("Run GraphQL query against a Mantle indexer")
        .requiredOption("--endpoint <url>", "GraphQL endpoint URL")
        .requiredOption("--query <graphql>", "GraphQL query document")
        .option("--variables <json>", "optional GraphQL variables as JSON string")
        .option("--timeout <ms>", "request timeout in milliseconds", (value) => parseIntegerOption(value, "--timeout"))
        .action(async (opts, cmd) => {
        const globals = cmd.optsWithGlobals();
        const variables = opts.variables
            ? parseJsonString(opts.variables, "variables")
            : undefined;
        const result = await allTools["mantle_querySubgraph"].handler({
            endpoint: opts.endpoint,
            query: opts.query,
            variables,
            timeout_ms: opts.timeout,
            network: globals.network
        });
        if (globals.json) {
            formatJson(result);
        }
        else {
            const data = result;
            formatKeyValue({
                endpoint: data.endpoint,
                queried_at: data.queried_at_utc,
                elapsed_ms: data.elapsed_ms
            }, {
                labels: {
                    endpoint: "Endpoint",
                    queried_at: "Queried At",
                    elapsed_ms: "Elapsed (ms)"
                }
            });
            if (data.errors) {
                console.log("  Errors:", JSON.stringify(data.errors, null, 2));
            }
            if (data.data) {
                console.log(JSON.stringify(data.data, null, 2));
            }
        }
    });
    group
        .command("sql")
        .description("Run read-only SQL query against an indexer")
        .requiredOption("--endpoint <url>", "SQL indexer endpoint URL")
        .requiredOption("--query <sql>", "read-only SQL query")
        .option("--params <json>", "optional query params as JSON string")
        .option("--timeout <ms>", "request timeout in milliseconds", (value) => parseIntegerOption(value, "--timeout"))
        .action(async (opts, cmd) => {
        const globals = cmd.optsWithGlobals();
        const params = opts.params
            ? parseJsonString(opts.params, "params")
            : undefined;
        const result = await allTools["mantle_queryIndexerSql"].handler({
            endpoint: opts.endpoint,
            query: opts.query,
            params,
            timeout_ms: opts.timeout,
            network: globals.network
        });
        if (globals.json) {
            formatJson(result);
        }
        else {
            const data = result;
            const columns = (data.columns ?? []);
            const rows = (data.rows ?? []);
            console.log(`\n  Endpoint: ${data.endpoint}  Rows: ${data.row_count}  Elapsed: ${data.elapsed_ms}ms\n`);
            if (rows.length > 0 && columns.length > 0) {
                const tableRows = rows.map((row) => {
                    const record = {};
                    columns.forEach((col, i) => {
                        record[col] = Array.isArray(row) ? row[i] : row[col];
                    });
                    return record;
                });
                formatTable(tableRows, columns.map((col) => ({ key: col, label: col })));
            }
            if (data.truncated) {
                console.log("  (Results truncated)");
            }
        }
    });
}
