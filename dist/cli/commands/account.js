import { allTools } from "../../src/tools/index.js";
import { formatKeyValue, formatTable, formatJson } from "../formatter.js";
import { parseCommaList } from "../utils.js";
export function registerAccount(parent) {
    const group = parent.command("account").description("Wallet and account queries");
    group
        .command("balance")
        .description("Get native MNT balance for an address")
        .argument("<address>", "wallet address")
        .action(async (address, _opts, cmd) => {
        const globals = cmd.optsWithGlobals();
        const result = await allTools["mantle_getBalance"].handler({
            address,
            network: globals.network
        });
        if (globals.json) {
            formatJson(result);
        }
        else {
            const data = result;
            formatKeyValue(data, {
                order: ["address", "network", "balance_mnt", "block_number", "collected_at_utc"],
                labels: {
                    address: "Address",
                    network: "Network",
                    balance_mnt: "Balance (MNT)",
                    block_number: "Block",
                    collected_at_utc: "Collected At"
                }
            });
        }
    });
    group
        .command("token-balances")
        .description("Batch read ERC-20 token balances")
        .argument("<address>", "wallet address")
        .requiredOption("--tokens <tokens>", "comma-separated token symbols or addresses")
        .action(async (address, opts, cmd) => {
        const globals = cmd.optsWithGlobals();
        const tokens = parseCommaList(opts.tokens);
        const result = await allTools["mantle_getTokenBalances"].handler({
            address,
            tokens,
            network: globals.network
        });
        if (globals.json) {
            formatJson(result);
        }
        else {
            const data = result;
            const balances = (data.balances ?? []);
            console.log(`\n  Address: ${data.address}  Network: ${data.network}  Block: ${data.block_number}\n`);
            formatTable(balances, [
                { key: "symbol", label: "Token" },
                { key: "balance_normalized", label: "Balance", align: "right" },
                { key: "token_address", label: "Address" },
                { key: "error", label: "Error" }
            ]);
        }
    });
    group
        .command("allowances")
        .description("Batch read ERC-20 allowances for token/spender pairs")
        .argument("<owner>", "owner address")
        .requiredOption("--pairs <pairs>", "comma-separated token:spender pairs")
        .action(async (owner, opts, cmd) => {
        const globals = cmd.optsWithGlobals();
        const pairsRaw = parseCommaList(opts.pairs);
        const pairs = pairsRaw.map((pair) => {
            const [token, spender] = pair.split(":");
            return { token, spender };
        });
        const result = await allTools["mantle_getAllowances"].handler({
            owner,
            pairs,
            network: globals.network
        });
        if (globals.json) {
            formatJson(result);
        }
        else {
            const data = result;
            const allowances = (data.allowances ?? []);
            console.log(`\n  Owner: ${data.owner}  Network: ${data.network}  Block: ${data.block_number}\n`);
            formatTable(allowances, [
                { key: "token_symbol", label: "Token" },
                { key: "spender", label: "Spender" },
                { key: "spender_label", label: "Spender Label" },
                { key: "allowance_normalized", label: "Allowance", align: "right" },
                { key: "is_unlimited", label: "Unlimited" },
                { key: "error", label: "Error" }
            ]);
        }
    });
}
