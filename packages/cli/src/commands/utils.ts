import type { Command } from "commander";
import { allTools } from "@mantleio/mantle-core/tools/index.js";
import { formatKeyValue, formatJson } from "../formatter.js";
import { parseIntegerOption } from "../utils.js";

/**
 * Utility commands — safe encoding/decoding primitives:
 *   utils parse-units   — Decimal → raw integer (wei) conversion
 *   utils format-units  — Raw integer → decimal conversion
 *   utils encode-call   — ABI-encode a contract function call
 */
export function registerUtils(parent: Command): void {
  const group = parent
    .command("utils")
    .description(
      "Safe encoding/decoding utilities. Use these instead of Python/JS for hex, wei, and calldata computation."
    );

  // ── parse-units ──────────────────────────────────────────────────────
  group
    .command("parse-units")
    .description(
      "Convert a decimal amount to raw integer (wei). " +
      "Use instead of manually computing amount * 10**decimals."
    )
    .requiredOption("--amount <amount>", "decimal amount (e.g. '100', '1.5')")
    .option(
      "--decimals <n>",
      "token decimals (default: 18)",
      (v: string) => parseIntegerOption(v, "--decimals")
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_parseUnits"].handler({
        amount: String(opts.amount),
        decimals: opts.decimals
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        formatKeyValue(data, {
          order: ["amount_decimal", "decimals", "amount_raw", "amount_hex"],
          labels: {
            amount_decimal: "Decimal",
            decimals: "Decimals",
            amount_raw: "Raw (integer)",
            amount_hex: "Raw (hex)"
          }
        });
      }
    });

  // ── format-units ─────────────────────────────────────────────────────
  group
    .command("format-units")
    .description(
      "Convert a raw integer (wei) to decimal amount. " +
      "Use instead of manually computing amount / 10**decimals."
    )
    .requiredOption("--amount-raw <raw>", "raw integer amount as string")
    .option(
      "--decimals <n>",
      "token decimals (default: 18)",
      (v: string) => parseIntegerOption(v, "--decimals")
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_formatUnits"].handler({
        amount_raw: String(opts.amountRaw),
        decimals: opts.decimals
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        formatKeyValue(data, {
          order: ["amount_raw", "decimals", "amount_decimal"],
          labels: {
            amount_raw: "Raw (integer)",
            decimals: "Decimals",
            amount_decimal: "Decimal"
          }
        });
      }
    });

  // ── encode-call ──────────────────────────────────────────────────────
  group
    .command("encode-call")
    .description(
      "ABI-encode a contract function call. Returns hex calldata. " +
      "Use ONLY when no dedicated CLI command exists for the operation."
    )
    .requiredOption(
      "--abi <abi>",
      'ABI as JSON array or human-readable (e.g. \'function transfer(address to, uint256 amount)\')'
    )
    .requiredOption("--function <name>", "function name to call")
    .option("--args <json>", "function arguments as JSON array (e.g. '[\"0xAddr\", \"1000\"]')")
    .option("--to <address>", "target contract address (includes unsigned_tx in output)")
    .option("--value <hex>", "hex-encoded MNT value (default: 0x0)")
    .option(
      "--chain-id <n>",
      "chain ID (default: 5000)",
      (v: string) => parseIntegerOption(v, "--chain-id")
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();

      let parsedArgs: unknown[] = [];
      if (typeof opts.args === "string") {
        try {
          parsedArgs = JSON.parse(opts.args);
          if (!Array.isArray(parsedArgs)) {
            console.error("Error: --args must be a JSON array.");
            process.exit(1);
          }
        } catch {
          console.error("Error: --args must be valid JSON.");
          process.exit(1);
        }
      }

      const result = await allTools["mantle_encodeCall"].handler({
        abi: opts.abi,
        function_name: opts.function,
        args: parsedArgs,
        to: opts.to,
        value: opts.value,
        chain_id: opts.chainId
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        formatKeyValue(data, {
          order: ["function_name", "encoded_data", "data_length_bytes"],
          labels: {
            function_name: "Function",
            encoded_data: "Calldata",
            data_length_bytes: "Data length"
          }
        });
        if (data.unsigned_tx) {
          console.log("\n  ⚠ unsigned_tx included (target address provided)");
          console.log("  ⚠ This is UNVERIFIED manual construction — use dedicated CLI commands when available.");
        }
      }
    });

  // ── build-tx ─────────────────────────────────────────────────────────
  group
    .command("build-tx")
    .description(
      "Build an unsigned_tx from raw calldata. Final step for unsupported operations: " +
      "validates address, hex format, converts decimal MNT to wei."
    )
    .requiredOption("--to <address>", "target contract or recipient address")
    .requiredOption(
      "--data <hex>",
      "hex-encoded calldata (from encode-call). Use '0x' for plain MNT transfer."
    )
    .option("--value <amount>", "MNT to send: decimal (e.g. '0.5') or hex (e.g. '0x0')")
    .option("--description <text>", "human-readable summary of the transaction")
    .option(
      "--chain-id <n>",
      "chain ID (default: 5000)",
      (v: string) => parseIntegerOption(v, "--chain-id")
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_buildRawTx"].handler({
        to: opts.to,
        data: opts.data,
        value: opts.value,
        description: opts.description,
        chain_id: opts.chainId,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        console.log(`\n  ⚠ ${data.human_summary}`);
        const warnings = (data.warnings ?? []) as string[];
        for (const w of warnings) {
          console.log(`  ${w}`);
        }
        const tx = data.unsigned_tx as Record<string, unknown>;
        console.log(`\n  to:      ${tx.to}`);
        console.log(`  data:    ${String(tx.data).slice(0, 42)}${String(tx.data).length > 42 ? "..." : ""}`);
        console.log(`  value:   ${tx.value}`);
        console.log(`  chainId: ${tx.chainId}\n`);
      }
    });
}
