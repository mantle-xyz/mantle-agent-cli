import { allTools } from "../../src/tools/index.js";
import { formatKeyValue, formatTable, formatJson } from "../formatter.js";
import { parseIntegerOption, parseNumberOption } from "../utils.js";
export function registerDefi(parent) {
    const group = parent.command("defi").description("DeFi read-only operations");
    group
        .command("swap-quote")
        .description("Get swap quotes for Agni and Merchant Moe routes")
        .requiredOption("--in <token>", "input token symbol or address")
        .requiredOption("--out <token>", "output token symbol or address")
        .requiredOption("--amount <amount>", "human-readable amount in")
        .option("--provider <provider>", "routing provider (agni, merchant_moe, best)", "best")
        .option("--fee-tier <tier>", "optional V3 fee tier", (value) => parseNumberOption(value, "--fee-tier"))
        .action(async (opts, cmd) => {
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
        }
        else {
            const data = result;
            const tokenIn = data.token_in;
            const tokenOut = data.token_out;
            formatKeyValue({
                provider: data.provider,
                token_in: `${tokenIn.symbol} (${tokenIn.address})`,
                token_out: `${tokenOut.symbol} (${tokenOut.address})`,
                amount_in: data.amount_in_decimal,
                estimated_out: data.estimated_out_decimal,
                minimum_out: data.minimum_out_decimal,
                price_impact: data.price_impact_pct,
                router: data.router_address,
                route: data.route,
                quoted_at: data.quoted_at_utc
            }, {
                labels: {
                    provider: "Provider",
                    token_in: "Token In",
                    token_out: "Token Out",
                    amount_in: "Amount In",
                    estimated_out: "Estimated Out",
                    minimum_out: "Minimum Out (0.5% slip)",
                    price_impact: "Price Impact %",
                    router: "Router Address",
                    route: "Route",
                    quoted_at: "Quoted At"
                }
            });
        }
    });
    group
        .command("pool-liquidity")
        .description("Read pool reserves and liquidity metadata")
        .argument("<pool-address>", "pool contract address")
        .option("--provider <provider>", "DEX provider (agni, merchant_moe)", "agni")
        .action(async (poolAddress, opts, cmd) => {
        const globals = cmd.optsWithGlobals();
        const result = await allTools["mantle_getPoolLiquidity"].handler({
            pool_address: poolAddress,
            provider: opts.provider,
            network: globals.network
        });
        if (globals.json) {
            formatJson(result);
        }
        else {
            const data = result;
            const token0 = data.token_0;
            const token1 = data.token_1;
            formatKeyValue({
                pool_address: data.pool_address,
                provider: data.provider,
                token_0: `${token0.symbol} (${token0.address})`,
                token_1: `${token1.symbol} (${token1.address})`,
                reserve_0: data.reserve_0_decimal,
                reserve_1: data.reserve_1_decimal,
                total_liquidity_usd: data.total_liquidity_usd,
                fee_tier: data.fee_tier,
                collected_at: data.collected_at_utc
            }, {
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
            });
        }
    });
    group
        .command("pool-opportunities")
        .description("Scan and rank pools for a token pair")
        .requiredOption("--token-a <token>", "first token symbol or address")
        .requiredOption("--token-b <token>", "second token symbol or address")
        .option("--provider <provider>", "DEX provider filter (agni, merchant_moe, all)", "all")
        .option("--max-results <n>", "max candidates (1-10)", (value) => parseIntegerOption(value, "--max-results"), 5)
        .action(async (opts, cmd) => {
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
        }
        else {
            const data = result;
            const candidates = (data.candidates ?? []);
            console.log(`\n  Token A: ${data.token_a.symbol}  Token B: ${data.token_b.symbol}\n`);
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
        .action(async (opts, cmd) => {
        const globals = cmd.optsWithGlobals();
        const result = await allTools["mantle_getProtocolTvl"].handler({
            protocol: opts.protocol,
            network: globals.network
        });
        if (globals.json) {
            formatJson(result);
        }
        else {
            const data = result;
            const breakdown = (data.breakdown ?? []);
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
    group
        .command("lending-markets")
        .description("Aave v3 lending market metrics")
        .option("--protocol <protocol>", "lending protocol (aave_v3, all)", "all")
        .option("--asset <asset>", "optional asset filter (symbol or address)")
        .action(async (opts, cmd) => {
        const globals = cmd.optsWithGlobals();
        const result = await allTools["mantle_getLendingMarkets"].handler({
            protocol: opts.protocol,
            asset: opts.asset,
            network: globals.network
        });
        if (globals.json) {
            formatJson(result);
        }
        else {
            const data = result;
            const markets = (data.markets ?? []);
            formatTable(markets, [
                { key: "asset", label: "Asset" },
                { key: "supply_apy", label: "Supply APY%", align: "right" },
                { key: "borrow_apy_variable", label: "Borrow APY%", align: "right" },
                {
                    key: "tvl_usd",
                    label: "TVL (USD)",
                    align: "right",
                    format: (v) => (v === null ? "N/A" : `$${Number(v).toLocaleString()}`)
                },
                { key: "ltv", label: "LTV%", align: "right" },
                { key: "liquidation_threshold", label: "Liq Threshold%", align: "right" }
            ]);
        }
    });
    group
        .command("lb-state")
        .description("Read Merchant Moe LB pair on-chain state (active bin, reserves)")
        .option("--pair <address>", "LB pair address (or use --token-a/--token-b/--bin-step)")
        .option("--token-a <token>", "first token symbol or address")
        .option("--token-b <token>", "second token symbol or address")
        .option("--bin-step <step>", "LB bin step", (v) => parseIntegerOption(v, "--bin-step"))
        .action(async (opts, cmd) => {
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
        }
        else {
            const data = result;
            formatKeyValue({
                pair: data.pair_address,
                active_id: data.active_id,
                bin_step: data.bin_step
            }, {
                labels: {
                    pair: "LB Pair",
                    active_id: "Active Bin ID",
                    bin_step: "Bin Step"
                }
            });
            const bins = (data.nearby_bins ?? []);
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
    group
        .command("analyze-pool")
        .description("Deep analysis of a V3 pool: fee APR, multi-range APR comparison, risk assessment, and investment projections")
        .option("--pool <address>", "V3 pool address (or use --token-a/--token-b/--fee-tier/--provider)")
        .option("--token-a <token>", "first token symbol or address")
        .option("--token-b <token>", "second token symbol or address")
        .option("--fee-tier <tier>", "V3 fee tier (500, 3000, 10000)", (v) => parseNumberOption(v, "--fee-tier"))
        .option("--provider <provider>", "DEX provider (agni, fluxion)")
        .option("--investment <usd>", "USD amount for return projections (default: 1000)", (v) => parseNumberOption(v, "--investment"), 1000)
        .action(async (opts, cmd) => {
        const globals = cmd.optsWithGlobals();
        const result = await allTools["mantle_analyzePool"].handler({
            pool_address: opts.pool,
            token_a: opts.tokenA,
            token_b: opts.tokenB,
            fee_tier: opts.feeTier,
            provider: opts.provider,
            investment_usd: opts.investment,
            network: globals.network
        });
        if (globals.json) {
            formatJson(result);
        }
        else {
            const data = result;
            const token0 = data.token0;
            const token1 = data.token1;
            const market = data.market_data;
            const risk = data.risk;
            const investment = data.investment;
            // Pool overview
            formatKeyValue({
                pool: data.pool_address,
                provider: data.provider,
                pair: `${token0.symbol} / ${token1.symbol}`,
                fee: `${data.fee_rate_pct}%`,
                price: `${data.current_price_token1_per_token0} ${token1.symbol}/${token0.symbol}`,
                tvl: market.tvl_usd != null ? `$${Number(market.tvl_usd).toLocaleString()}` : "N/A",
                volume_24h: market.volume_24h_usd != null ? `$${Number(market.volume_24h_usd).toLocaleString()}` : "N/A",
                change_24h: market.price_change_24h_pct != null ? `${market.price_change_24h_pct}%` : "N/A",
                base_fee_apr: market.base_fee_apr_pct != null ? `${market.base_fee_apr_pct}%` : "N/A"
            }, {
                labels: {
                    pool: "Pool",
                    provider: "Provider",
                    pair: "Pair",
                    fee: "Fee Tier",
                    price: "Current Price",
                    tvl: "TVL (USD)",
                    volume_24h: "24h Volume (USD)",
                    change_24h: "24h Price Change",
                    base_fee_apr: "Base Fee APR"
                }
            });
            // Range analysis table
            const ranges = (data.ranges ?? []);
            const recommended = data.recommended_range;
            console.log(`  Investment: $${Number(investment.amount_usd).toLocaleString()}    Recommended range: ${recommended ?? "N/A"}\n`);
            formatTable(ranges, [
                {
                    key: "label",
                    label: "Range",
                    format: (v) => (v === recommended ? `${v} *` : String(v))
                },
                { key: "fee_apr_pct", label: "Fee APR%", align: "right" },
                { key: "concentration_factor", label: "Conc. Factor", align: "right" },
                {
                    key: "daily_fee_usd",
                    label: "Daily Fee",
                    align: "right",
                    format: (v) => (v != null ? `$${v}` : "N/A")
                },
                {
                    key: "monthly_fee_usd",
                    label: "Monthly Fee",
                    align: "right",
                    format: (v) => (v != null ? `$${v}` : "N/A")
                },
                { key: "rebalance_risk", label: "Rebal. Risk" }
            ]);
            // Risk assessment
            const details = (risk.details ?? []);
            formatKeyValue({
                overall: risk.overall,
                tvl_risk: risk.tvl_risk,
                volatility_risk: risk.volatility_risk,
                concentration_risk: risk.concentration_risk
            }, {
                labels: {
                    overall: "Overall Risk",
                    tvl_risk: "TVL Risk",
                    volatility_risk: "Volatility Risk",
                    concentration_risk: "Concentration Risk"
                }
            });
            if (details.length > 0) {
                for (const detail of details) {
                    console.log(`  · ${detail}`);
                }
                console.log();
            }
        }
    });
}
