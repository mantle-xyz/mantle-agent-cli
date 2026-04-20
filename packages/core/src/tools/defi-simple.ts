/**
 * DeFi Simple Tools — high-level facade tools that consolidate multi-step
 * DeFi workflows behind minimal user-friendly APIs.
 *
 * Design goals:
 *  - Take only the parameters the user actually thinks about
 *    (user / token / amount), and auto-discover everything else
 *    (provider, fee tier / bin step, router/spender, recipient,
 *    slippage, range preset, …).
 *  - Return one or more `unsigned_tx` payloads in execution order, so the
 *    caller can sign and broadcast them sequentially.
 *  - Smart-sequential approval: when an approval is needed, return ONLY the
 *    approve transaction(s) with status="approval_required" and a next_step
 *    hint.  After the approve confirms on-chain, re-invoke the same tool with
 *    the same arguments to receive the main operation transaction.  This avoids
 *    the "stale gas estimation" trap where the inner build-handler simulates
 *    the main op against pre-approve state and reverts.
 *
 * NEVER hold private keys, sign, or broadcast transactions.
 *
 * ---------------------------------------------------------------------------
 * Exported tools & parameters
 * ---------------------------------------------------------------------------
 *
 * ── DEX ──────────────────────────────────────────────────────────────────────
 *
 * mantle_simpleSwap          swap(user, token_in, amount_in, token_out)
 *   Required : user        string  Wallet address (signer / recipient)
 *              token_in    string  Input token symbol or ERC-20 address
 *              amount_in   string  Decimal amount to swap (e.g. "100")
 *              token_out   string  Output token symbol or ERC-20 address
 *   Optional : slippage_bps number  Slippage in bps (default 50 = 0.5 %)
 *              network      string  "mainnet" (default) | "sepolia"
 *   Approval : ERC-20 allowance for router — smart-sequential re-invoke
 *
 * ── Liquidity ────────────────────────────────────────────────────────────────
 *
 * mantle_simpleAddLp         addLp(user, token_a, amount_a, token_b, amount_b)
 *   Required : user        string  Wallet address
 *              token_a     string  First token symbol or address
 *              amount_a    string  Decimal amount of token_a
 *              token_b     string  Second token symbol or address
 *              amount_b    string  Decimal amount of token_b
 *   Optional : range_preset string  "aggressive" | "moderate" (default) | "conservative"
 *              slippage_bps number  Slippage in bps (default 50)
 *              network      string  "mainnet" (default) | "sepolia"
 *   Approval : ERC-20 allowance for position_manager (V3) or lb_router (LB) — smart-sequential re-invoke
 *
 * mantle_simpleRemoveLp      removeLp(user, token_a, token_b)
 *   Required : user        string  Wallet address
 *              token_a     string  First token symbol or address
 *              token_b     string  Second token symbol or address
 *   Optional : percentage  number  % of each position to remove (1-100, default 100)
 *              network      string  "mainnet" (default) | "sepolia"
 *   Approval : setApprovalForAll for LB router (if LB positions present) — smart-sequential re-invoke
 *   Note     : status="no_action" when no matching positions found
 *
 * mantle_simpleQueryAllLp    queryAllLp(user)
 *   Required : user        string  Wallet address
 *   Optional : network      string  "mainnet" (default) | "sepolia"
 *   Returns  : SimpleQueryResult  (no status / unsigned_txs — read-only)
 *
 * ── Aave V3 Lending ──────────────────────────────────────────────────────────
 *
 * mantle_simpleSupply        supply(user, asset, amount)
 *   Required : user        string  Wallet address
 *              asset       string  Token symbol or address to supply
 *              amount      string  Decimal amount to supply
 *   Optional : network      string  "mainnet" (default) | "sepolia"
 *   Approval : ERC-20 allowance for Aave Pool — smart-sequential re-invoke
 *
 * mantle_simpleBorrow        borrow(user, asset, amount)
 *   Required : user        string  Wallet address
 *              asset       string  Token symbol or address to borrow
 *              amount      string  Decimal amount to borrow
 *   Optional : interest_rate_mode number  2 = variable (default), 1 = stable
 *              network              string  "mainnet" (default) | "sepolia"
 *   Approval : none required
 *   Note     : sufficient collateral must already be supplied
 *
 * mantle_simpleRepay         repay(user, asset, amount)
 *   Required : user        string  Wallet address
 *              asset       string  Token symbol or address to repay
 *              amount      string  Decimal amount, or "max" for full debt
 *   Optional : interest_rate_mode number  2 = variable (default), 1 = stable
 *              network              string  "mainnet" (default) | "sepolia"
 *   Approval : ERC-20 allowance for Aave Pool (unlimited when amount="max") — smart-sequential re-invoke
 *
 * mantle_simpleWithdraw      withdraw(user, asset, amount)
 *   Required : user        string  Wallet address
 *              asset       string  Token symbol or address to withdraw
 *              amount      string  Decimal amount, or "max" for full aToken balance
 *   Optional : network      string  "mainnet" (default) | "sepolia"
 *   Approval : none required (aToken burn does not need an ERC-20 approval)
 *
 * ---------------------------------------------------------------------------
 * Return shape (SimpleResult) for all write tools
 * ---------------------------------------------------------------------------
 *
 *   status        "ready_to_sign" | "approval_required" | "no_action"
 *   next_step     Human-readable instruction for the caller
 *   steps[]       Ordered list of steps; each may carry an unsigned_tx
 *   unsigned_txs  Flat array of executable txs in broadcast order
 *   warnings      Non-fatal notices from underlying build handlers
 *   built_at_utc  ISO timestamp of when the response was built
 *   details       Tool-specific metadata (quote, pool info, position list, …)
 */

import { isAddress, getAddress } from "viem";

import { MantleMcpError } from "../errors.js";
import { MANTLE_PROTOCOLS } from "../config/protocols.js";
import type { Tool, Network } from "../types.js";

import { defiReadTools } from "./defi-read.js";
import { defiLpReadTools } from "./defi-lp-read.js";
import { defiLendingReadTools } from "./defi-lending-read.js";
import { defiWriteTools } from "./defi-write.js";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

type SimpleStep = {
  step: string; // "approve" | "approve_token_a" | "approve_token_b" | "swap" | "add_liquidity" | …
  human_summary?: string;
  unsigned_tx?: unknown;
  intent?: string;
  warnings?: unknown;
  // Metadata about the underlying build call (optional, surfaced for debugging).
  meta?: Record<string, unknown>;
};

type SimpleResult = {
  intent: string;
  user: string;
  network: Network;
  status: "ready_to_sign" | "approval_required" | "no_action" | "complete";
  next_step: string | null;
  steps: SimpleStep[];
  // Aggregate, executable transactions in order. Excludes `approve_skip`
  // entries (which have data:"0x" and are noops on-chain).
  unsigned_txs: unknown[];
  warnings: string[];
  built_at_utc: string;
  // Tool-specific extra info (quote, pool selection, position list, …).
  details?: Record<string, unknown>;
};

/** Return type for read-only query tools (no status / unsigned_txs). */
type SimpleQueryResult = {
  intent: string;
  user: string;
  network: Network;
  total_v3_positions: number;
  total_lb_positions: number;
  v3_positions: unknown[];
  lb_positions: unknown[];
  v3_warnings: unknown;
  lb_note: unknown;
  queried_at_utc: string;
};

function nowUtc(): string {
  return new Date().toISOString();
}

function normalizeNetwork(args: Record<string, unknown>): Network {
  const raw = typeof args.network === "string" ? args.network : "mainnet";
  if (raw !== "mainnet" && raw !== "sepolia") {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `Unsupported network '${raw}'.`,
      "Use network='mainnet' (default) or network='sepolia'.",
      { network: raw }
    );
  }
  return raw;
}

function requireAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `'${field}' must be a 0x-prefixed Ethereum address.`,
      `Provide ${field} as a checksummed or lowercase 0x… address.`,
      { [field]: value === undefined ? null : value }
    );
  }
  return getAddress(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `'${field}' is required.`,
      `Provide a non-empty string for ${field}.`,
      { [field]: value === undefined ? null : value }
    );
  }
  return value.trim();
}

function getSpenderForLp(provider: string, network: Network): string {
  // Mirrors the resolution logic inside buildAddLiquidity:
  //   V3 (agni / fluxion) → position_manager
  //   Merchant Moe LB     → lb_router_v2_2
  const proto = MANTLE_PROTOCOLS[network]?.[provider];
  if (!proto) {
    throw new MantleMcpError(
      "UNSUPPORTED_PROTOCOL",
      `Protocol '${provider}' not registered on ${network}.`,
      "Use provider=agni | fluxion | merchant_moe.",
      { provider, network }
    );
  }
  const key =
    provider === "agni" || provider === "fluxion"
      ? "position_manager"
      : provider === "merchant_moe"
        ? "lb_router_v2_2"
        : null;
  if (!key) {
    throw new MantleMcpError(
      "UNSUPPORTED_PROTOCOL",
      `Provider '${provider}' has no LP spender mapping.`,
      "Use provider=agni | fluxion | merchant_moe.",
      { provider }
    );
  }
  const addr = proto.contracts[key];
  if (!addr) {
    throw new MantleMcpError(
      "UNSUPPORTED_PROTOCOL",
      `Contract '${key}' for ${provider} not configured on ${network}.`,
      "This contract may not be deployed on the selected network.",
      { provider, contract: key, network }
    );
  }
  return addr;
}

function getAavePoolAddress(network: Network): string {
  const addr = MANTLE_PROTOCOLS[network]?.aave_v3?.contracts?.pool;
  if (!addr) {
    throw new MantleMcpError(
      "UNSUPPORTED_PROTOCOL",
      `Aave V3 Pool not configured on ${network}.`,
      "Aave V3 is currently only available on mainnet.",
      { network }
    );
  }
  return addr;
}

// Module-level registry — built once at import time so callTool doesn't
// re-spread hundreds of keys on every invocation.
const toolRegistry: Record<string, Tool> = {
  ...defiReadTools,
  ...defiLpReadTools,
  ...defiLendingReadTools,
  ...defiWriteTools
};

/**
 * Run a wrapped build handler and surface MantleMcpError details intact.
 * Wrapped handlers may return a normal result OR throw a MantleMcpError;
 * we let the caller handle both shapes.
 */
async function callTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<any> {
  const tool = toolRegistry[toolName];
  if (!tool) {
    throw new MantleMcpError(
      "INTERNAL_ERROR",
      `Underlying tool '${toolName}' is not registered.`,
      "This is a bug — file an issue.",
      { tool: toolName }
    );
  }
  return await tool.handler(args);
}

function isApproveSkip(result: any): boolean {
  return (
    result &&
    typeof result === "object" &&
    typeof result.intent === "string" &&
    result.intent.endsWith("_skip")
  );
}

function pickUnsignedTx(result: any): unknown {
  if (result && typeof result === "object" && "unsigned_tx" in result) {
    return result.unsigned_tx;
  }
  return null;
}

function pickWarnings(result: any): string[] {
  if (result && Array.isArray(result.warnings)) {
    return result.warnings.filter((w: unknown) => typeof w === "string");
  }
  return [];
}

function buildResult(opts: {
  intent: string;
  user: string;
  network: Network;
  steps: SimpleStep[];
  status: SimpleResult["status"];
  nextStep: string | null;
  warnings?: string[];
  details?: Record<string, unknown>;
}): SimpleResult {
  const executableTxs: unknown[] = [];
  for (const s of opts.steps) {
    if (s.intent && s.intent.endsWith("_skip")) continue;
    if (s.unsigned_tx) executableTxs.push(s.unsigned_tx);
  }
  return {
    intent: opts.intent,
    user: opts.user,
    network: opts.network,
    status: opts.status,
    next_step: opts.nextStep,
    steps: opts.steps,
    unsigned_txs: executableTxs,
    warnings: opts.warnings ?? [],
    built_at_utc: nowUtc(),
    details: opts.details
  };
}

// ---------------------------------------------------------------------------
// Tool 1: mantle_simpleSwap
// ---------------------------------------------------------------------------

async function simpleSwap(args: Record<string, unknown>): Promise<SimpleResult> {
  const network = normalizeNetwork(args);
  const user = requireAddress(args.user, "user");
  const tokenIn = requireString(args.token_in, "token_in");
  const tokenOut = requireString(args.token_out, "token_out");
  const amountIn = requireString(args.amount_in, "amount_in");
  const slippageBps =
    typeof args.slippage_bps === "number" ? args.slippage_bps : undefined;

  const quote = await callTool("mantle_getSwapQuote", {
    token_in: tokenIn,
    token_out: tokenOut,
    amount_in: amountIn,
    provider: "best",
    network
  });

  const provider: string = quote.provider;
  const routerAddress: string = quote.router_address;
  const minimumOutRaw: string = quote.minimum_out_raw;
  const resolved = quote.resolved_pool_params ?? {};
  const feeTier: number | undefined =
    typeof quote.fee_tier === "number"
      ? quote.fee_tier
      : typeof resolved.fee_tier === "number"
        ? resolved.fee_tier
        : undefined;
  const binStep: number | undefined =
    typeof resolved.bin_step === "number" ? resolved.bin_step : undefined;

  // Guard: after the quote resolves token addresses, verify they are distinct.
  if (
    quote.resolved_in_address &&
    quote.resolved_out_address &&
    (quote.resolved_in_address as string).toLowerCase() ===
      (quote.resolved_out_address as string).toLowerCase()
  ) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "'token_in' and 'token_out' resolve to the same asset.",
      "Provide two different tokens to swap.",
      {
        token_in: tokenIn,
        token_out: tokenOut,
        resolved_address: quote.resolved_in_address
      }
    );
  }

  const warnings: string[] = [];
  if (Array.isArray(quote.warnings)) {
    for (const w of quote.warnings) {
      if (typeof w === "string") warnings.push(`[quote] ${w}`);
    }
  }

  const approveResult = await callTool("mantle_buildApprove", {
    token: tokenIn,
    spender: routerAddress,
    amount: amountIn,
    owner: user,
    network
  });

  warnings.push(...pickWarnings(approveResult).map((w) => `[approve] ${w}`));

  // Allowance not yet sufficient — return approve only and ask the caller
  // to re-invoke once it's confirmed. We cannot bundle the swap here
  // because wrapBuildHandler will simulate it pre-approve and revert.
  if (!isApproveSkip(approveResult)) {
    return buildResult({
      intent: "simple_swap",
      user,
      network,
      status: "approval_required",
      nextStep:
        `Sign and broadcast the approve transaction, wait for inclusion, then re-call mantle_simpleSwap with the same arguments to receive the swap transaction.`,
      steps: [
        {
          step: "approve",
          intent: approveResult.intent,
          human_summary: approveResult.human_summary,
          unsigned_tx: pickUnsignedTx(approveResult),
          warnings: approveResult.warnings,
          meta: {
            spender: routerAddress,
            spender_label: "router",
            token: tokenIn,
            amount: amountIn
          }
        }
      ],
      warnings,
      details: { quote }
    });
  }

  const swapArgs: Record<string, unknown> = {
    provider,
    token_in: tokenIn,
    token_out: tokenOut,
    amount_in: amountIn,
    recipient: user,
    owner: user,
    amount_out_min: minimumOutRaw,
    network,
    quote_provider: provider
  };
  if (typeof feeTier === "number") {
    swapArgs.fee_tier = feeTier;
    swapArgs.quote_fee_tier = feeTier;
  }
  if (typeof binStep === "number") {
    swapArgs.bin_step = binStep;
    swapArgs.quote_bin_step = binStep;
  }
  if (typeof slippageBps === "number") swapArgs.slippage_bps = slippageBps;

  const swapResult = await callTool("mantle_buildSwap", swapArgs);
  warnings.push(...pickWarnings(swapResult).map((w) => `[swap] ${w}`));

  return buildResult({
    intent: "simple_swap",
    user,
    network,
    status: "ready_to_sign",
    nextStep: "Sign and broadcast the swap transaction.",
    steps: [
      {
        step: "swap",
        intent: swapResult.intent,
        human_summary: swapResult.human_summary,
        unsigned_tx: pickUnsignedTx(swapResult),
        warnings: swapResult.warnings,
        meta: { provider, router: routerAddress, fee_tier: feeTier, bin_step: binStep }
      }
    ],
    warnings,
    details: { quote }
  });
}

// ---------------------------------------------------------------------------
// Tool 2: mantle_simpleAddLp
// ---------------------------------------------------------------------------

async function simpleAddLp(args: Record<string, unknown>): Promise<SimpleResult> {
  const network = normalizeNetwork(args);
  const user = requireAddress(args.user, "user");
  const tokenA = requireString(args.token_a, "token_a");
  const amountA = requireString(args.amount_a, "amount_a");
  const tokenB = requireString(args.token_b, "token_b");
  const amountB = requireString(args.amount_b, "amount_b");
  const rangePreset =
    typeof args.range_preset === "string" ? args.range_preset : "moderate";
  const slippageBps =
    typeof args.slippage_bps === "number" ? args.slippage_bps : undefined;

  const pools = await callTool("mantle_findPools", {
    token_a: tokenA,
    token_b: tokenB,
    network
  });

  const recommended = pools?.recommended_pool;
  if (!recommended) {
    throw new MantleMcpError(
      "NO_POOL_FOUND",
      `No pool with positive TVL found for ${tokenA}/${tokenB} on ${network}.`,
      "Verify the token symbols/addresses, or supply liquidity manually via mantle_buildAddLiquidity once a pool exists.",
      {
        token_a: tokenA,
        token_b: tokenB,
        network,
        pools_found: Array.isArray(pools?.pools) ? pools.pools.length : 0
      }
    );
  }

  const provider: string = recommended.provider;
  const feeTier: number | undefined =
    typeof recommended.fee_tier === "number" ? recommended.fee_tier : undefined;
  const binStep: number | undefined =
    typeof recommended.bin_step === "number" ? recommended.bin_step : undefined;

  const spender = getSpenderForLp(provider, network);
  const warnings: string[] = [];

  // Pre-check both token allowances. Use buildApprove (auto skip if sufficient).
  const [approveAResult, approveBResult] = await Promise.all([
    callTool("mantle_buildApprove", {
      token: tokenA,
      spender,
      amount: amountA,
      owner: user,
      network
    }),
    callTool("mantle_buildApprove", {
      token: tokenB,
      spender,
      amount: amountB,
      owner: user,
      network
    })
  ]);

  const aSkip = isApproveSkip(approveAResult);
  const bSkip = isApproveSkip(approveBResult);

  warnings.push(...pickWarnings(approveAResult).map((w) => `[approve_a] ${w}`));
  warnings.push(...pickWarnings(approveBResult).map((w) => `[approve_b] ${w}`));

  if (!aSkip || !bSkip) {
    const steps: SimpleStep[] = [];
    if (!aSkip) {
      steps.push({
        step: "approve_token_a",
        intent: approveAResult.intent,
        human_summary: approveAResult.human_summary,
        unsigned_tx: pickUnsignedTx(approveAResult),
        warnings: approveAResult.warnings,
        meta: { token: tokenA, spender, amount: amountA }
      });
    }
    if (!bSkip) {
      steps.push({
        step: "approve_token_b",
        intent: approveBResult.intent,
        human_summary: approveBResult.human_summary,
        unsigned_tx: pickUnsignedTx(approveBResult),
        warnings: approveBResult.warnings,
        meta: { token: tokenB, spender, amount: amountB }
      });
    }

    return buildResult({
      intent: "simple_add_lp",
      user,
      network,
      status: "approval_required",
      nextStep:
        "Sign and broadcast the approve transaction(s), wait for inclusion, then re-call mantle_simpleAddLp with the same arguments to receive the add-liquidity transaction.",
      steps,
      warnings,
      details: { recommended_pool: recommended }
    });
  }

  const addArgs: Record<string, unknown> = {
    provider,
    token_a: tokenA,
    token_b: tokenB,
    amount_a: amountA,
    amount_b: amountB,
    recipient: user,
    owner: user,
    range_preset: rangePreset,
    network
  };
  if (typeof feeTier === "number") addArgs.fee_tier = feeTier;
  if (typeof binStep === "number") addArgs.bin_step = binStep;
  if (typeof slippageBps === "number") addArgs.slippage_bps = slippageBps;

  const addResult = await callTool("mantle_buildAddLiquidity", addArgs);
  warnings.push(...pickWarnings(addResult).map((w) => `[add_liquidity] ${w}`));

  return buildResult({
    intent: "simple_add_lp",
    user,
    network,
    status: "ready_to_sign",
    nextStep: "Sign and broadcast the add-liquidity transaction.",
    steps: [
      {
        step: "add_liquidity",
        intent: addResult.intent,
        human_summary: addResult.human_summary,
        unsigned_tx: pickUnsignedTx(addResult),
        warnings: addResult.warnings,
        meta: {
          provider,
          fee_tier: feeTier,
          bin_step: binStep,
          range_preset: rangePreset,
          spender
        }
      }
    ],
    warnings,
    details: { recommended_pool: recommended }
  });
}

// ---------------------------------------------------------------------------
// Tool 3: mantle_simpleRemoveLp
// ---------------------------------------------------------------------------

function tokensMatchPair(
  pairA: { address: string; symbol?: string | null },
  pairB: { address: string; symbol?: string | null },
  wantedA: string,
  wantedB: string
): boolean {
  // Match by address (case-insensitive) OR by symbol (case-insensitive).
  // wantedA / wantedB may be either symbol or address.
  const normalize = (v: string) => v.trim().toLowerCase();
  const pa = normalize(pairA.address);
  const pb = normalize(pairB.address);
  const sa = pairA.symbol ? normalize(pairA.symbol) : "";
  const sb = pairB.symbol ? normalize(pairB.symbol) : "";
  const wa = normalize(wantedA);
  const wb = normalize(wantedB);

  const matchAB =
    (pa === wa || sa === wa) && (pb === wb || sb === wb);
  const matchBA =
    (pa === wb || sa === wb) && (pb === wa || sb === wa);
  return matchAB || matchBA;
}

async function simpleRemoveLp(args: Record<string, unknown>): Promise<SimpleResult> {
  const network = normalizeNetwork(args);
  const user = requireAddress(args.user, "user");
  const tokenA = requireString(args.token_a, "token_a");
  const tokenB = requireString(args.token_b, "token_b");
  const percentage =
    typeof args.percentage === "number" ? args.percentage : 100;

  if (percentage <= 0 || percentage > 100) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "'percentage' must be in (0, 100].",
      "Use percentage=100 to remove all liquidity (default), or a smaller value to partially withdraw.",
      { percentage }
    );
  }

  const [v3Res, lbRes] = await Promise.all([
    callTool("mantle_getV3Positions", { owner: user, network }),
    callTool("mantle_getLBPositions", { owner: user, network })
  ]);

  const v3Positions: any[] = Array.isArray(v3Res?.positions) ? v3Res.positions : [];
  const lbPositions: any[] = Array.isArray(lbRes?.positions) ? lbRes.positions : [];

  const matchedV3 = v3Positions.filter((p) =>
    tokensMatchPair(p.token0, p.token1, tokenA, tokenB) &&
    BigInt(p.liquidity ?? "0") > 0n
  );
  const matchedLB = lbPositions.filter(
    (p) =>
      tokensMatchPair(p.token_x, p.token_y, tokenA, tokenB) &&
      Array.isArray(p.bins) &&
      p.bins.some((b: any) => BigInt(b.balance_raw ?? "0") > 0n)
  );

  if (matchedV3.length === 0 && matchedLB.length === 0) {
    return buildResult({
      intent: "simple_remove_lp",
      user,
      network,
      status: "no_action",
      nextStep: null,
      steps: [],
      warnings: [
        `No active LP positions found for ${tokenA}/${tokenB} on ${network} (scanned V3 + Merchant Moe LB).`
      ],
      details: {
        matched_v3_positions: 0,
        matched_lb_positions: 0,
        v3_warnings: v3Res?.warnings ?? null,
        lb_note: lbRes?.note ?? null
      }
    });
  }

  const warnings: string[] = [];

  // ---------------------------------------------------------------------------
  // Phase 1 (LB only): verify setApprovalForAll for each matched LB pair.
  //
  // Gate the entire remove behind any outstanding approvals — same pattern as
  // simpleSwap / simpleAddLp / simpleSupply.  Return ONLY the approve steps
  // with status="approval_required" and ask the caller to re-invoke once they
  // confirm; on re-invocation buildSetLBApprovalForAll will auto-skip because
  // isApprovedForAll is now true on-chain, and we fall through to Phase 2.
  //
  // NOTE: buildRemoveLiquidity's internal isApprovedForAll pre-check reads
  // isApprovedForAll(recipient, router).  simpleRemoveLp always sets
  // owner === recipient === user, so the check is correct.  If you ever split
  // owner from recipient, update that pre-check in defi-write.ts accordingly.
  // ---------------------------------------------------------------------------
  if (matchedLB.length > 0) {
    const lbRouter = MANTLE_PROTOCOLS[network]?.merchant_moe?.contracts?.lb_router_v2_2;
    if (!lbRouter) {
      throw new MantleMcpError(
        "UNSUPPORTED_PROTOCOL",
        `lb_router_v2_2 not configured for merchant_moe on ${network}.`,
        "Cannot build Merchant Moe LB removal without a router address.",
        { network }
      );
    }

    // Check all LB pairs for operator approval in parallel (read-only calls,
    // no nonce concerns).
    const approvalChecks = await Promise.all(
      matchedLB.map((pos) =>
        callTool("mantle_buildSetLBApprovalForAll", {
          pair: pos.pair_address,
          operator: lbRouter,
          approved: true,
          owner: user,
          network
        }).then((approveOp: any) => ({ pos, approveOp }))
      )
    );

    const approvalSteps: SimpleStep[] = [];
    for (const { pos, approveOp } of approvalChecks) {
      warnings.push(
        ...pickWarnings(approveOp).map(
          (w) => `[lb_approveForAll pair=${pos.pair_address}] ${w}`
        )
      );
      if (!isApproveSkip(approveOp)) {
        approvalSteps.push({
          step: "approve_for_all_lb",
          intent: approveOp.intent,
          human_summary: approveOp.human_summary,
          unsigned_tx: pickUnsignedTx(approveOp),
          warnings: approveOp.warnings,
          meta: {
            pair: pos.pair_address,
            operator: lbRouter,
            token_x: pos.token_x,
            token_y: pos.token_y
          }
        });
      }
    }

    if (approvalSteps.length > 0) {
      return buildResult({
        intent: "simple_remove_lp",
        user,
        network,
        status: "approval_required",
        nextStep:
          "Sign and broadcast the approve_for_all_lb transaction(s), wait for inclusion, then re-call mantle_simpleRemoveLp with the same arguments to receive the liquidity-removal transactions.",
        steps: approvalSteps,
        warnings,
        details: {
          matched_v3_positions: matchedV3.length,
          matched_lb_positions: matchedLB.length,
          percentage
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 2: All LB operator approvals are confirmed (or there are no LB
  // positions).  Build removal transactions.
  // ---------------------------------------------------------------------------
  const steps: SimpleStep[] = [];

  // V3 removals — one per NFT position (sequential; nonce ordering is the
  // caller's responsibility at broadcast time).
  for (const pos of matchedV3) {
    const removeArgs: Record<string, unknown> = {
      provider: pos.provider,
      recipient: user,
      owner: user,
      token_id: pos.token_id,
      percentage,
      network
    };
    const result = await callTool("mantle_buildRemoveLiquidity", removeArgs);
    warnings.push(
      ...pickWarnings(result).map(
        (w) => `[remove_v3 token_id=${pos.token_id}] ${w}`
      )
    );
    steps.push({
      step: "remove_v3_position",
      intent: result.intent,
      human_summary: result.human_summary,
      unsigned_tx: pickUnsignedTx(result),
      warnings: result.warnings,
      meta: {
        provider: pos.provider,
        token_id: pos.token_id,
        percentage,
        token0: pos.token0,
        token1: pos.token1
      }
    });
  }

  // Merchant Moe LB removals — one per pair (sequential).
  for (const pos of matchedLB) {
    const removeArgs: Record<string, unknown> = {
      provider: "merchant_moe",
      recipient: user,
      owner: user,
      token_a: pos.token_x.address,
      token_b: pos.token_y.address,
      bin_step: pos.bin_step,
      percentage,
      network
    };
    const result = await callTool("mantle_buildRemoveLiquidity", removeArgs);
    warnings.push(
      ...pickWarnings(result).map(
        (w) => `[remove_lb pair=${pos.pair_address}] ${w}`
      )
    );
    steps.push({
      step: "remove_lb_position",
      intent: result.intent,
      human_summary: result.human_summary,
      unsigned_tx: pickUnsignedTx(result),
      warnings: result.warnings,
      meta: {
        pair: pos.pair_address,
        bin_step: pos.bin_step,
        percentage,
        token_x: pos.token_x,
        token_y: pos.token_y,
        bins_with_liquidity: pos.total_bins_with_liquidity
      }
    });
  }

  return buildResult({
    intent: "simple_remove_lp",
    user,
    network,
    status: "ready_to_sign",
    nextStep: "Sign and broadcast the remove transactions in order.",
    steps,
    warnings,
    details: {
      matched_v3_positions: matchedV3.length,
      matched_lb_positions: matchedLB.length,
      percentage
    }
  });
}

// ---------------------------------------------------------------------------
// Tool 4: mantle_simpleQueryAllLp
// ---------------------------------------------------------------------------

async function simpleQueryAllLp(args: Record<string, unknown>): Promise<SimpleQueryResult> {
  const network = normalizeNetwork(args);
  const user = requireAddress(args.user, "user");

  const [v3Res, lbRes] = await Promise.all([
    callTool("mantle_getV3Positions", { owner: user, network }),
    callTool("mantle_getLBPositions", { owner: user, network })
  ]);

  const v3Positions: any[] = Array.isArray(v3Res?.positions) ? v3Res.positions : [];
  const lbPositions: any[] = Array.isArray(lbRes?.positions) ? lbRes.positions : [];

  return {
    intent: "simple_query_all_lp",
    user,
    network,
    total_v3_positions: v3Positions.length,
    total_lb_positions: lbPositions.length,
    v3_positions: v3Positions,
    lb_positions: lbPositions,
    v3_warnings: v3Res?.warnings ?? null,
    lb_note: lbRes?.note ?? null,
    queried_at_utc: nowUtc()
  };
}

// ---------------------------------------------------------------------------
// Tool 5: mantle_simpleSupply (Aave V3)
// ---------------------------------------------------------------------------

async function simpleSupply(args: Record<string, unknown>): Promise<SimpleResult> {
  const network = normalizeNetwork(args);
  const user = requireAddress(args.user, "user");
  const asset = requireString(args.asset, "asset");
  const amount = requireString(args.amount, "amount");

  const poolAddr = getAavePoolAddress(network);
  const warnings: string[] = [];

  const approveResult = await callTool("mantle_buildApprove", {
    token: asset,
    spender: poolAddr,
    amount,
    owner: user,
    network
  });
  warnings.push(...pickWarnings(approveResult).map((w) => `[approve] ${w}`));

  if (!isApproveSkip(approveResult)) {
    return buildResult({
      intent: "simple_supply",
      user,
      network,
      status: "approval_required",
      nextStep:
        "Sign and broadcast the approve transaction, wait for inclusion, then re-call mantle_simpleSupply with the same arguments to receive the supply transaction.",
      steps: [
        {
          step: "approve",
          intent: approveResult.intent,
          human_summary: approveResult.human_summary,
          unsigned_tx: pickUnsignedTx(approveResult),
          warnings: approveResult.warnings,
          meta: { token: asset, spender: poolAddr, amount }
        }
      ],
      warnings
    });
  }

  const supplyResult = await callTool("mantle_buildAaveSupply", {
    asset,
    amount,
    on_behalf_of: user,
    network
  });
  warnings.push(...pickWarnings(supplyResult).map((w) => `[supply] ${w}`));

  return buildResult({
    intent: "simple_supply",
    user,
    network,
    status: "ready_to_sign",
    nextStep: "Sign and broadcast the Aave supply transaction.",
    steps: [
      {
        step: "aave_supply",
        intent: supplyResult.intent,
        human_summary: supplyResult.human_summary,
        unsigned_tx: pickUnsignedTx(supplyResult),
        warnings: supplyResult.warnings,
        meta: { pool: poolAddr, asset, amount }
      }
    ],
    warnings
  });
}

// ---------------------------------------------------------------------------
// Tool 6: mantle_simpleBorrow (Aave V3, variable rate)
// ---------------------------------------------------------------------------

async function simpleBorrow(args: Record<string, unknown>): Promise<SimpleResult> {
  const network = normalizeNetwork(args);
  const user = requireAddress(args.user, "user");
  const asset = requireString(args.asset, "asset");
  const amount = requireString(args.amount, "amount");
  const interestRateMode =
    typeof args.interest_rate_mode === "number" ? args.interest_rate_mode : 2;

  const borrowResult = await callTool("mantle_buildAaveBorrow", {
    asset,
    amount,
    on_behalf_of: user,
    interest_rate_mode: interestRateMode,
    network
  });

  const warnings = pickWarnings(borrowResult).map((w) => `[borrow] ${w}`);

  return buildResult({
    intent: "simple_borrow",
    user,
    network,
    status: "ready_to_sign",
    nextStep: "Sign and broadcast the Aave borrow transaction.",
    steps: [
      {
        step: "aave_borrow",
        intent: borrowResult.intent,
        human_summary: borrowResult.human_summary,
        unsigned_tx: pickUnsignedTx(borrowResult),
        warnings: borrowResult.warnings,
        meta: { asset, amount, interest_rate_mode: interestRateMode }
      }
    ],
    warnings
  });
}

// ---------------------------------------------------------------------------
// Tool 7: mantle_simpleRepay (Aave V3)
// ---------------------------------------------------------------------------

async function simpleRepay(args: Record<string, unknown>): Promise<SimpleResult> {
  const network = normalizeNetwork(args);
  const user = requireAddress(args.user, "user");
  const asset = requireString(args.asset, "asset");
  const amount = requireString(args.amount, "amount");
  const interestRateMode =
    typeof args.interest_rate_mode === "number" ? args.interest_rate_mode : 2;

  const poolAddr = getAavePoolAddress(network);
  const isMax = amount.toLowerCase() === "max";
  const warnings: string[] = [];

  // For amount='max' we need the Pool to be able to pull the full debt.
  // Approving 'max' (uint256.max) is the standard pattern: the actual
  // transferFrom inside Pool.repay() is bounded by the debt, so unlimited
  // approval is safe and avoids race conditions with accruing interest.
  const approveAmount = isMax ? "max" : amount;
  const approveResult = await callTool("mantle_buildApprove", {
    token: asset,
    spender: poolAddr,
    amount: approveAmount,
    owner: user,
    network
  });
  warnings.push(...pickWarnings(approveResult).map((w) => `[approve] ${w}`));

  if (!isApproveSkip(approveResult)) {
    return buildResult({
      intent: "simple_repay",
      user,
      network,
      status: "approval_required",
      nextStep:
        "Sign and broadcast the approve transaction, wait for inclusion, then re-call mantle_simpleRepay with the same arguments to receive the repay transaction.",
      steps: [
        {
          step: "approve",
          intent: approveResult.intent,
          human_summary: approveResult.human_summary,
          unsigned_tx: pickUnsignedTx(approveResult),
          warnings: approveResult.warnings,
          meta: { token: asset, spender: poolAddr, amount: approveAmount }
        }
      ],
      warnings
    });
  }

  const repayResult = await callTool("mantle_buildAaveRepay", {
    asset,
    amount,
    on_behalf_of: user,
    interest_rate_mode: interestRateMode,
    network
  });
  warnings.push(...pickWarnings(repayResult).map((w) => `[repay] ${w}`));

  return buildResult({
    intent: "simple_repay",
    user,
    network,
    status: "ready_to_sign",
    nextStep: "Sign and broadcast the Aave repay transaction.",
    steps: [
      {
        step: "aave_repay",
        intent: repayResult.intent,
        human_summary: repayResult.human_summary,
        unsigned_tx: pickUnsignedTx(repayResult),
        warnings: repayResult.warnings,
        meta: { asset, amount, interest_rate_mode: interestRateMode, pool: poolAddr }
      }
    ],
    warnings
  });
}

// ---------------------------------------------------------------------------
// Tool 8: mantle_simpleWithdraw (Aave V3)
// ---------------------------------------------------------------------------

async function simpleWithdraw(args: Record<string, unknown>): Promise<SimpleResult> {
  const network = normalizeNetwork(args);
  const user = requireAddress(args.user, "user");
  const asset = requireString(args.asset, "asset");
  const amount = requireString(args.amount, "amount");

  const withdrawResult = await callTool("mantle_buildAaveWithdraw", {
    asset,
    amount,
    to: user,
    owner: user,
    network
  });
  const warnings = pickWarnings(withdrawResult).map((w) => `[withdraw] ${w}`);

  return buildResult({
    intent: "simple_withdraw",
    user,
    network,
    status: "ready_to_sign",
    nextStep: "Sign and broadcast the Aave withdraw transaction.",
    steps: [
      {
        step: "aave_withdraw",
        intent: withdrawResult.intent,
        human_summary: withdrawResult.human_summary,
        unsigned_tx: pickUnsignedTx(withdrawResult),
        warnings: withdrawResult.warnings,
        meta: { asset, amount }
      }
    ],
    warnings
  });
}

// ---------------------------------------------------------------------------
// Tool definitions (schema)
// ---------------------------------------------------------------------------

const COMMON_USER_DESC =
  "Wallet address that owns the funds and signs the transaction(s). " +
  "Used as recipient/owner/on_behalf_of for the underlying operation.";

const SMART_SEQUENTIAL_NOTE =
  "Smart-sequential approval: when ERC-20 allowance is insufficient, " +
  "this tool returns ONLY the approve transaction(s) along with " +
  "status='approval_required' and a next_step hint. After signing and " +
  "broadcasting the approve(s) and waiting for inclusion, re-invoke this " +
  "tool with the same arguments to receive the main operation.";

export const defiSimpleTools: Record<string, Tool> = {
  mantle_simpleSwap: {
    name: "mantle_simpleSwap",
    description:
      "High-level facade for token swaps on Mantle. Auto-discovers the best " +
      "DEX (agni / fluxion / merchant_moe) via mantle_getSwapQuote, resolves " +
      "router/fee_tier/bin_step, and applies a 0.5% slippage minimum_out by " +
      "default (the quote's minimum_out_raw).\n\n" +
      SMART_SEQUENTIAL_NOTE +
      "\n\nExamples:\n" +
      "- Swap 100 USDC for USDT0: user='0x…', token_in='USDC', amount_in='100', token_out='USDT0'\n" +
      "- Swap with custom slippage: user='0x…', token_in='WMNT', amount_in='10', token_out='USDC', slippage_bps=100",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: COMMON_USER_DESC },
        token_in: {
          type: "string",
          description: "Input token symbol (e.g. 'USDC') or ERC-20 address."
        },
        amount_in: {
          type: "string",
          description: "Decimal amount of token_in to swap (e.g. '100')."
        },
        token_out: {
          type: "string",
          description: "Output token symbol or ERC-20 address."
        },
        slippage_bps: {
          type: "number",
          description:
            "Optional slippage tolerance in basis points (default: 50 = 0.5%)."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["user", "token_in", "amount_in", "token_out"]
    },
    handler: simpleSwap as unknown as (
      args: Record<string, unknown>
    ) => Promise<unknown>
  },

  mantle_simpleAddLp: {
    name: "mantle_simpleAddLp",
    description:
      "High-level facade for adding liquidity to the recommended pool for " +
      "(token_a, token_b). Auto-selects DEX/pool via mantle_findPools " +
      "(highest TVL × 0.6 + volume × 0.4 score), resolves spender " +
      "(position_manager for V3 / lb_router for Merchant Moe), and applies a " +
      "moderate (±10%) range preset by default.\n\n" +
      SMART_SEQUENTIAL_NOTE +
      "\n\nExamples:\n" +
      "- Add LP: user='0x…', token_a='WMNT', amount_a='10', token_b='USDC', amount_b='8'\n" +
      "- Tighter range: ..., range_preset='aggressive'",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: COMMON_USER_DESC },
        token_a: { type: "string", description: "First token symbol or address." },
        amount_a: { type: "string", description: "Decimal amount of token_a." },
        token_b: { type: "string", description: "Second token symbol or address." },
        amount_b: { type: "string", description: "Decimal amount of token_b." },
        range_preset: {
          type: "string",
          description:
            "Price range preset: 'aggressive' (±5%), 'moderate' (±10%, default), or 'conservative' (±20%)."
        },
        slippage_bps: {
          type: "number",
          description: "Optional slippage tolerance in basis points (default: 50)."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["user", "token_a", "amount_a", "token_b", "amount_b"]
    },
    handler: simpleAddLp as unknown as (
      args: Record<string, unknown>
    ) => Promise<unknown>
  },

  mantle_simpleRemoveLp: {
    name: "mantle_simpleRemoveLp",
    description:
      "High-level facade for removing liquidity for the (token_a, token_b) " +
      "pair across both V3 (Agni / Fluxion NFT positions) and Merchant Moe " +
      "Liquidity Book bins. Scans both providers via mantle_getV3Positions " +
      "and mantle_getLBPositions, filters to positions matching the requested " +
      "pair, and produces one removal tx per matched position.\n\n" +
      SMART_SEQUENTIAL_NOTE +
      " For LB positions the approval is setApprovalForAll (operator approval), " +
      "not an ERC-20 allowance — re-invoke after it confirms to receive the removal transactions.\n\n" +
      "Defaults to percentage=100 (close all matching positions). Provide " +
      "percentage=N (1–100) for a partial withdraw applied to every matched " +
      "position.\n\n" +
      "If no matching position exists, status='no_action' is returned with no transactions.\n\n" +
      "Examples:\n" +
      "- Close all WMNT/USDC LP: user='0x…', token_a='WMNT', token_b='USDC'\n" +
      "- Withdraw 25% across all matching positions: ..., percentage=25",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: COMMON_USER_DESC },
        token_a: { type: "string", description: "First token symbol or address." },
        token_b: { type: "string", description: "Second token symbol or address." },
        percentage: {
          type: "number",
          description:
            "Percentage of each matched position to remove (1-100, default 100)."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["user", "token_a", "token_b"]
    },
    handler: simpleRemoveLp as unknown as (
      args: Record<string, unknown>
    ) => Promise<unknown>
  },

  mantle_simpleQueryAllLp: {
    name: "mantle_simpleQueryAllLp",
    description:
      "Read-only facade that returns every LP position owned by `user` " +
      "across both V3 (Agni / Fluxion NFT positions) and Merchant Moe " +
      "Liquidity Book bins. Calls mantle_getV3Positions and " +
      "mantle_getLBPositions concurrently and returns the union.\n\n" +
      "Examples:\n- All LP positions: user='0x…'",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: "Wallet address to enumerate LP positions for." },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["user"]
    },
    handler: simpleQueryAllLp
  },

  mantle_simpleSupply: {
    name: "mantle_simpleSupply",
    description:
      "High-level facade for supplying an asset to Aave V3 on Mantle.\n\n" +
      SMART_SEQUENTIAL_NOTE +
      "\n\nExamples:\n- Supply 100 USDC: user='0x…', asset='USDC', amount='100'",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: COMMON_USER_DESC },
        asset: {
          type: "string",
          description: "Token symbol or address to supply."
        },
        amount: {
          type: "string",
          description: "Decimal amount to supply."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["user", "asset", "amount"]
    },
    handler: simpleSupply as unknown as (
      args: Record<string, unknown>
    ) => Promise<unknown>
  },

  mantle_simpleBorrow: {
    name: "mantle_simpleBorrow",
    description:
      "High-level facade for borrowing from Aave V3 on Mantle (variable rate by default).\n\n" +
      "Borrowing requires sufficient collateral already supplied. No approval is needed.\n\n" +
      "Examples:\n- Borrow 50 USDC: user='0x…', asset='USDC', amount='50'\n" +
      "- Stable rate: ..., interest_rate_mode=1",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: COMMON_USER_DESC },
        asset: { type: "string", description: "Token symbol or address to borrow." },
        amount: { type: "string", description: "Decimal amount to borrow." },
        interest_rate_mode: {
          type: "number",
          description: "2 = variable (default), 1 = stable."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["user", "asset", "amount"]
    },
    handler: simpleBorrow as unknown as (
      args: Record<string, unknown>
    ) => Promise<unknown>
  },

  mantle_simpleRepay: {
    name: "mantle_simpleRepay",
    description:
      "High-level facade for repaying Aave V3 debt on Mantle. Use amount='max' to repay the full outstanding debt.\n\n" +
      "When amount='max', this tool requests an unlimited approve so the Pool can pull the full (interest-accruing) debt without race conditions.\n\n" +
      SMART_SEQUENTIAL_NOTE +
      "\n\nExamples:\n- Repay 50 USDC: user='0x…', asset='USDC', amount='50'\n- Repay full WMNT debt: ..., amount='max'",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: COMMON_USER_DESC },
        asset: { type: "string", description: "Token symbol or address to repay." },
        amount: {
          type: "string",
          description: "Decimal amount to repay, or 'max' for full debt."
        },
        interest_rate_mode: {
          type: "number",
          description: "2 = variable (default), 1 = stable."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["user", "asset", "amount"]
    },
    handler: simpleRepay as unknown as (
      args: Record<string, unknown>
    ) => Promise<unknown>
  },

  mantle_simpleWithdraw: {
    name: "mantle_simpleWithdraw",
    description:
      "High-level facade for withdrawing supplied assets from Aave V3 on Mantle. " +
      "Use amount='max' to withdraw the full aToken balance. No approval needed " +
      "(burning aTokens does not require a token approval).\n\n" +
      "Examples:\n- Withdraw 50 USDC: user='0x…', asset='USDC', amount='50'\n- Withdraw all WMNT: ..., amount='max'",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: COMMON_USER_DESC },
        asset: { type: "string", description: "Token symbol or address to withdraw." },
        amount: {
          type: "string",
          description: "Decimal amount to withdraw, or 'max' for full balance."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["user", "asset", "amount"]
    },
    handler: simpleWithdraw as unknown as (
      args: Record<string, unknown>
    ) => Promise<unknown>
  }
};
