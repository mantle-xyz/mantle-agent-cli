import type { Command } from "commander";
import { allTools } from "../../src/tools/index.js";
import { formatKeyValue, formatTable, formatJson } from "../formatter.js";
import { parseIntegerOption, parseNumberOption, parseJsonArray } from "../utils.js";

/**
 * Liquidity provision operations:
 *   lp add           — Build unsigned add-liquidity transaction
 *   lp remove        — Build unsigned remove-liquidity transaction
 *   lp positions     — List V3 LP positions for an owner
 *   lp pool-state    — Read V3 pool on-chain state (tick, price, liquidity)
 *   lp collect-fees  — Build unsigned fee collection transaction
 *   lp suggest-ticks — Suggest tick ranges for V3 LP
 */
export function registerLp(parent: Command): void {
  const group = parent
    .command("lp")
    .description("Liquidity provision operations (build unsigned transactions)");

  // ── add ─────────────────────────────────────────────────────────────
  group
    .command("add")
    .description(
      "Build unsigned add-liquidity transaction. " +
      "V3 (agni/fluxion) mints an NFT position; Merchant Moe LB adds to bins."
    )
    .requiredOption("--provider <provider>", "DEX provider: agni, fluxion, or merchant_moe")
    .requiredOption("--token-a <token>", "first token symbol or address")
    .requiredOption("--token-b <token>", "second token symbol or address")
    .requiredOption("--amount-a <amount>", "decimal amount of token A")
    .requiredOption("--amount-b <amount>", "decimal amount of token B")
    .requiredOption("--recipient <address>", "address to receive LP position")
    .option(
      "--slippage-bps <bps>",
      "slippage tolerance in basis points (default: 50)",
      (v: string) => parseIntegerOption(v, "--slippage-bps")
    )
    .option(
      "--fee-tier <tier>",
      "V3 fee tier (default: 3000). For agni/fluxion",
      (v: string) => parseNumberOption(v, "--fee-tier")
    )
    .option(
      "--tick-lower <tick>",
      "lower tick bound. For agni/fluxion. Default: full range",
      (v: string) => parseIntegerOption(v, "--tick-lower")
    )
    .option(
      "--tick-upper <tick>",
      "upper tick bound. For agni/fluxion. Default: full range",
      (v: string) => parseIntegerOption(v, "--tick-upper")
    )
    .option(
      "--bin-step <step>",
      "LB bin step (default: 20). For merchant_moe",
      (v: string) => parseIntegerOption(v, "--bin-step")
    )
    .option(
      "--active-id <id>",
      "active bin ID. For merchant_moe",
      (v: string) => parseIntegerOption(v, "--active-id")
    )
    .option(
      "--id-slippage <slippage>",
      "bin ID slippage tolerance. For merchant_moe",
      (v: string) => parseIntegerOption(v, "--id-slippage")
    )
    .option("--delta-ids <json>", "relative bin IDs as JSON array. For merchant_moe")
    .option("--distribution-x <json>", "token X distribution per bin as JSON array. For merchant_moe")
    .option("--distribution-y <json>", "token Y distribution per bin as JSON array. For merchant_moe")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_buildAddLiquidity"].handler({
        provider: opts.provider,
        token_a: opts.tokenA,
        token_b: opts.tokenB,
        amount_a: String(opts.amountA),
        amount_b: String(opts.amountB),
        recipient: opts.recipient,
        slippage_bps: opts.slippageBps,
        fee_tier: opts.feeTier,
        tick_lower: opts.tickLower,
        tick_upper: opts.tickUpper,
        bin_step: opts.binStep,
        active_id: opts.activeId,
        id_slippage: opts.idSlippage,
        delta_ids: opts.deltaIds ? parseJsonArray(opts.deltaIds as string, "--delta-ids") : undefined,
        distribution_x: opts.distributionX
          ? parseJsonArray(opts.distributionX as string, "--distribution-x")
          : undefined,
        distribution_y: opts.distributionY
          ? parseJsonArray(opts.distributionY as string, "--distribution-y")
          : undefined,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatUnsignedTxResult(result as Record<string, unknown>);
      }
    });

  // ── remove ──────────────────────────────────────────────────────────
  group
    .command("remove")
    .description(
      "Build unsigned remove-liquidity transaction. " +
      "V3 uses decreaseLiquidity+collect; Merchant Moe LB removes from bins."
    )
    .requiredOption("--provider <provider>", "DEX provider: agni, fluxion, or merchant_moe")
    .requiredOption("--recipient <address>", "address to receive withdrawn tokens")
    .option("--token-id <id>", "V3 NFT position token ID. For agni/fluxion")
    .option("--liquidity <amount>", "amount of liquidity to remove. For agni/fluxion")
    .option("--token-a <token>", "first token symbol or address. For merchant_moe")
    .option("--token-b <token>", "second token symbol or address. For merchant_moe")
    .option(
      "--bin-step <step>",
      "LB bin step. For merchant_moe",
      (v: string) => parseIntegerOption(v, "--bin-step")
    )
    .option("--ids <json>", "bin IDs to remove from as JSON array. For merchant_moe")
    .option("--amounts <json>", "amounts per bin as JSON array. For merchant_moe")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const provider = String(opts.provider).toLowerCase();

      // V3 providers require --token-id and --liquidity
      if (provider === "agni" || provider === "fluxion") {
        if (!opts.tokenId) {
          throw new Error("--token-id is required for V3 providers (agni/fluxion).");
        }
        if (!opts.liquidity) {
          throw new Error(
            "--liquidity is required for V3 providers (agni/fluxion). " +
            "Provide the amount of liquidity to remove (must be > 0)."
          );
        }
        const liq = BigInt(opts.liquidity as string);
        if (liq <= 0n) {
          throw new Error(
            "--liquidity must be a positive value. " +
            "A zero-liquidity removal would produce a no-op or fee-collect-only transaction."
          );
        }
      }

      const result = await allTools["mantle_buildRemoveLiquidity"].handler({
        provider: opts.provider,
        recipient: opts.recipient,
        token_id: opts.tokenId,
        liquidity: opts.liquidity,
        token_a: opts.tokenA,
        token_b: opts.tokenB,
        bin_step: opts.binStep,
        ids: opts.ids ? parseJsonArray(opts.ids as string, "--ids") : undefined,
        amounts: opts.amounts ? parseJsonArray(opts.amounts as string, "--amounts") : undefined,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatUnsignedTxResult(result as Record<string, unknown>);
      }
    });

  // ── positions ───────────────────────────────────────────────────────
  group
    .command("positions")
    .description("List V3 LP positions for an owner across Agni and Fluxion")
    .requiredOption("--owner <address>", "wallet address to query")
    .option("--provider <provider>", "filter by provider: agni or fluxion")
    .option("--include-empty", "include zero-liquidity positions", false)
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_getV3Positions"].handler({
        owner: opts.owner,
        provider: opts.provider,
        include_empty: opts.includeEmpty,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        const positions = (data.positions ?? []) as Record<string, unknown>[];
        if (positions.length === 0) {
          console.log("\n  No V3 LP positions found.\n");
        } else {
          formatTable(positions, [
            { key: "token_id", label: "Token ID" },
            { key: "provider", label: "Provider" },
            {
              key: "token0",
              label: "Token 0",
              format: (v) => (v as Record<string, unknown>)?.symbol as string ?? "?"
            },
            {
              key: "token1",
              label: "Token 1",
              format: (v) => (v as Record<string, unknown>)?.symbol as string ?? "?"
            },
            { key: "fee", label: "Fee", align: "right" },
            { key: "tick_lower", label: "Tick Lo", align: "right" },
            { key: "tick_upper", label: "Tick Hi", align: "right" },
            { key: "liquidity", label: "Liquidity", align: "right" },
            {
              key: "in_range",
              label: "In Range",
              format: (v) => v === true ? "YES" : v === false ? "NO" : "?"
            }
          ]);
        }
      }
    });

  // ── pool-state ──────────────────────────────────────────────────────
  group
    .command("pool-state")
    .description("Read V3 pool on-chain state (tick, price, liquidity)")
    .option("--pool <address>", "pool contract address (or use --token-a/--token-b/--fee-tier)")
    .option("--token-a <token>", "first token symbol or address")
    .option("--token-b <token>", "second token symbol or address")
    .option(
      "--fee-tier <tier>",
      "V3 fee tier",
      (v: string) => parseNumberOption(v, "--fee-tier")
    )
    .option("--provider <provider>", "DEX provider: agni or fluxion", "agni")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_getV3PoolState"].handler({
        pool_address: opts.pool,
        token_a: opts.tokenA,
        token_b: opts.tokenB,
        fee_tier: opts.feeTier,
        provider: opts.provider,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        formatKeyValue(
          {
            pool: data.pool_address,
            provider: data.provider,
            current_tick: data.current_tick,
            tick_spacing: data.tick_spacing,
            liquidity: data.pool_liquidity,
            price_0_per_1: data.price_token0_per_token1,
            price_1_per_0: data.price_token1_per_token0
          },
          {
            labels: {
              pool: "Pool",
              provider: "Provider",
              current_tick: "Current Tick",
              tick_spacing: "Tick Spacing",
              liquidity: "Pool Liquidity",
              price_0_per_1: "Price (token0/token1)",
              price_1_per_0: "Price (token1/token0)"
            }
          }
        );
      }
    });

  // ── collect-fees ────────────────────────────────────────────────────
  group
    .command("collect-fees")
    .description("Build unsigned V3 fee collection transaction")
    .requiredOption("--provider <provider>", "DEX provider: agni or fluxion")
    .requiredOption("--token-id <id>", "V3 NFT position token ID")
    .requiredOption("--recipient <address>", "address to receive collected fees")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_buildCollectFees"].handler({
        provider: opts.provider,
        token_id: opts.tokenId,
        recipient: opts.recipient,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatUnsignedTxResult(result as Record<string, unknown>);
      }
    });

  // ── suggest-ticks ───────────────────────────────────────────────────
  group
    .command("suggest-ticks")
    .description("Suggest tick ranges for V3 LP (wide/moderate/tight strategies)")
    .option("--pool <address>", "pool contract address (or use --token-a/--token-b/--fee-tier)")
    .option("--token-a <token>", "first token symbol or address")
    .option("--token-b <token>", "second token symbol or address")
    .option(
      "--fee-tier <tier>",
      "V3 fee tier",
      (v: string) => parseNumberOption(v, "--fee-tier")
    )
    .option("--provider <provider>", "DEX provider: agni or fluxion", "agni")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_suggestTickRange"].handler({
        pool_address: opts.pool,
        token_a: opts.tokenA,
        token_b: opts.tokenB,
        fee_tier: opts.feeTier,
        provider: opts.provider,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        console.log(`\n  Current Tick: ${data.current_tick}  Tick Spacing: ${data.tick_spacing}\n`);
        const suggestions = (data.suggestions ?? []) as Record<string, unknown>[];
        formatTable(suggestions, [
          { key: "strategy", label: "Strategy" },
          { key: "tick_lower", label: "Tick Lower", align: "right" },
          { key: "tick_upper", label: "Tick Upper", align: "right" },
          {
            key: "price_lower",
            label: "Price Lower",
            align: "right",
            format: (v) => Number(v).toFixed(4)
          },
          {
            key: "price_upper",
            label: "Price Upper",
            align: "right",
            format: (v) => Number(v).toFixed(4)
          }
        ]);
      }
    });
}

// ---------------------------------------------------------------------------
// Shared formatter for unsigned-tx results
// ---------------------------------------------------------------------------

function formatUnsignedTxResult(data: Record<string, unknown>): void {
  const tx = data.unsigned_tx as Record<string, unknown> | undefined;
  const warnings = (data.warnings ?? []) as string[];

  formatKeyValue(
    {
      intent: data.intent,
      human_summary: data.human_summary,
      tx_to: tx?.to,
      tx_value: tx?.value,
      tx_chainId: tx?.chainId,
      tx_data: truncateHex(tx?.data as string | undefined),
      tx_gas: tx?.gas ?? "auto",
      built_at: data.built_at_utc
    },
    {
      labels: {
        intent: "Intent",
        human_summary: "Summary",
        tx_to: "To",
        tx_value: "Value (hex)",
        tx_chainId: "Chain ID",
        tx_data: "Calldata",
        tx_gas: "Gas Limit",
        built_at: "Built At"
      }
    }
  );

  if (warnings.length > 0) {
    console.log("  Warnings:");
    for (const w of warnings) {
      console.log(`    - ${w}`);
    }
    console.log();
  }
}

function truncateHex(hex: string | undefined): string {
  if (!hex) return "null";
  if (hex.length <= 66) return hex;
  return `${hex.slice(0, 34)}...${hex.slice(-16)} (${hex.length} chars)`;
}
