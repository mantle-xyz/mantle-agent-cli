import type { Command } from "commander";
import { allTools } from "@mantleio/mantle-core/tools/index.js";
import { formatKeyValue, formatTable, formatJson } from "../formatter.js";
import { parseIntegerOption, parseNumberOption } from "../utils.js";

export function registerDefi(parent: Command): void {
  const group = parent.command("defi").description("DeFi read-only operations");

  group
    .command("swap-quote")
    .description("Get swap quotes across Agni, Fluxion, and Merchant Moe (on-chain quoter primary, DexScreener fallback)")
    .requiredOption("--in <token>", "input token symbol or address")
    .requiredOption("--out <token>", "output token symbol or address")
    .requiredOption("--amount <amount>", "human-readable amount in")
    .option("--provider <provider>", "routing provider (agni, merchant_moe, best)", "best")
    .option("--fee-tier <tier>", "optional V3 fee tier", (value: string) =>
      parseNumberOption(value, "--fee-tier")
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_getSwapQuote"].handler({
        token_in: opts.in,
        token_out: opts.out,
        amount_in: String(opts.amount),
        provider: opts.provider,
        fee_tier: opts.feeTier,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        const tokenIn = data.token_in as Record<string, unknown>;
        const tokenOut = data.token_out as Record<string, unknown>;
        const poolParams = data.resolved_pool_params as Record<string, unknown> | null;
        const sourceTrace = (data.source_trace ?? []) as Record<string, unknown>[];
        const primarySource = sourceTrace.find((t) => t.status === "success");

        formatKeyValue(
          {
            provider: data.provider,
            token_in: `${tokenIn.symbol} (${tokenIn.address})`,
            token_out: `${tokenOut.symbol} (${tokenOut.address})`,
            amount_in: data.amount_in_decimal,
            estimated_out: data.estimated_out_decimal,
            minimum_out: `${data.minimum_out_decimal} (raw: ${data.minimum_out_raw})`,
            price_impact: data.price_impact_pct,
            fee_tier: poolParams?.fee_tier ?? data.fee_tier ?? "-",
            bin_step: poolParams?.bin_step ?? "-",
            pool_address: poolParams?.pool_address ?? "-",
            route: data.route,
            router: data.router_address,
            source: primarySource?.source ?? "unknown",
            quoted_at: data.quoted_at_utc
          },
          {
            labels: {
              provider: "Provider",
              token_in: "Token In",
              token_out: "Token Out",
              amount_in: "Amount In",
              estimated_out: "Estimated Out",
              minimum_out: "Minimum Out (0.5% slip)",
              price_impact: "Price Impact %",
              fee_tier: "Fee Tier",
              bin_step: "Bin Step",
              pool_address: "Pool Address",
              route: "Route",
              router: "Router Address",
              source: "Quote Source",
              quoted_at: "Quoted At"
            }
          }
        );
      }
    });

  group
    .command("pool-liquidity")
    .description("Read pool reserves and liquidity metadata")
    .argument("<pool-address>", "pool contract address")
    .option("--provider <provider>", "DEX provider (agni, merchant_moe)", "agni")
    .action(async (poolAddress: string, opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_getPoolLiquidity"].handler({
        pool_address: poolAddress,
        provider: opts.provider,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        const token0 = data.token_0 as Record<string, unknown>;
        const token1 = data.token_1 as Record<string, unknown>;
        formatKeyValue(
          {
            pool_address: data.pool_address,
            provider: data.provider,
            token_0: `${token0.symbol} (${token0.address})`,
            token_1: `${token1.symbol} (${token1.address})`,
            reserve_0: data.reserve_0_decimal,
            reserve_1: data.reserve_1_decimal,
            total_liquidity_usd: data.total_liquidity_usd,
            fee_tier: data.fee_tier,
            collected_at: data.collected_at_utc
          },
          {
            labels: {
              pool_address: "Pool",
              provider: "Provider",
              token_0: "Token 0",
              token_1: "Token 1",
              reserve_0: "Reserve 0",
              reserve_1: "Reserve 1",
              total_liquidity_usd: "Liquidity (USD)",
              fee_tier: "Fee Tier",
              collected_at: "Collected At"
            }
          }
        );
      }
    });

  group
    .command("pool-opportunities")
    .description("Scan and rank pools for a token pair")
    .requiredOption("--token-a <token>", "first token symbol or address")
    .requiredOption("--token-b <token>", "second token symbol or address")
    .option("--provider <provider>", "DEX provider filter (agni, merchant_moe, all)", "all")
    .option(
      "--max-results <n>",
      "max candidates (1-10)",
      (value: string) => parseIntegerOption(value, "--max-results"),
      5
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_getPoolOpportunities"].handler({
        token_a: opts.tokenA,
        token_b: opts.tokenB,
        provider: opts.provider,
        max_results: opts.maxResults,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        const candidates = (data.candidates ?? []) as Record<string, unknown>[];
        console.log(`\n  Token A: ${(data.token_a as Record<string, unknown>).symbol}  Token B: ${(data.token_b as Record<string, unknown>).symbol}\n`);
        formatTable(candidates, [
          { key: "provider", label: "Provider" },
          { key: "pool_address", label: "Pool Address" },
          {
            key: "liquidity_usd",
            label: "Liquidity (USD)",
            align: "right",
            format: (v) => (v === null ? "N/A" : String(v))
          },
          {
            key: "volume_24h_usd",
            label: "24h Volume (USD)",
            align: "right",
            format: (v) => (v === null ? "N/A" : String(v))
          },
          { key: "score", label: "Score", align: "right" }
        ]);
      }
    });

  group
    .command("tvl")
    .description("Protocol TVL for Mantle DeFi protocols")
    .option("--protocol <protocol>", "protocol (agni, merchant_moe, all)", "all")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_getProtocolTvl"].handler({
        protocol: opts.protocol,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        const breakdown = (data.breakdown ?? []) as Record<string, unknown>[];
        formatTable(breakdown, [
          { key: "protocol", label: "Protocol" },
          {
            key: "tvl_usd",
            label: "TVL (USD)",
            align: "right",
            format: (v) => (v === null ? "N/A" : `$${Number(v).toLocaleString()}`)
          },
          { key: "source", label: "Source" },
          { key: "updated_at_utc", label: "Updated At" }
        ]);
      }
    });

  // `defi lending-markets` was removed — use `mantle-cli aave markets`
  // (identical underlying tool, more natural command location).

  group
    .command("lb-state")
    .description("Read Merchant Moe LB pair on-chain state (active bin, reserves)")
    .option("--pair <address>", "LB pair address (or use --token-a/--token-b/--bin-step)")
    .option("--token-a <token>", "first token symbol or address")
    .option("--token-b <token>", "second token symbol or address")
    .option(
      "--bin-step <step>",
      "LB bin step",
      (v: string) => parseIntegerOption(v, "--bin-step")
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_getLBPairState"].handler({
        pair_address: opts.pair,
        token_a: opts.tokenA,
        token_b: opts.tokenB,
        bin_step: opts.binStep,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        const data = result as Record<string, unknown>;
        formatKeyValue(
          {
            pair: data.pair_address,
            active_id: data.active_id,
            bin_step: data.bin_step
          },
          {
            labels: {
              pair: "LB Pair",
              active_id: "Active Bin ID",
              bin_step: "Bin Step"
            }
          }
        );
        const bins = (data.nearby_bins ?? []) as Record<string, unknown>[];
        if (bins.length > 0) {
          formatTable(bins, [
            { key: "id", label: "Bin ID", align: "right" },
            { key: "delta", label: "Delta", align: "right" },
            { key: "reserve_x_decimal", label: "Reserve X", align: "right" },
            { key: "reserve_y_decimal", label: "Reserve Y", align: "right" },
            {
              key: "is_active",
              label: "Active",
              format: (v) => v === true ? "◆" : ""
            }
          ]);
        }
      }
    });

  // `defi analyze-pool` was removed — identical to `lp analyze`
  // (same underlying mantle_analyzePool tool). Use `mantle-cli lp analyze`.
}
