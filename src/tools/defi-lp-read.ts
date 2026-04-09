/**
 * DeFi LP Read Tools — on-chain reads for Uniswap V3 (Agni / Fluxion) pools
 * and Merchant Moe Liquidity Book pairs on Mantle.
 *
 * All tools are pure reads — no state mutation, no private keys.
 */

import { formatUnits, getAddress, isAddress } from "viem";
import { MANTLE_PROTOCOLS } from "../config/protocols.js";
import { MantleMcpError } from "../errors.js";
import { getPublicClient } from "../lib/clients.js";
import { normalizeNetwork } from "../lib/network.js";
import {
  resolveTokenInput as resolveTokenInputFromRegistry,
  type ResolvedTokenInput
} from "../lib/token-registry.js";
import type { Tool, Network } from "../types.js";

// ABIs
import {
  V3_POOL_ABI,
  V3_FACTORY_ABI,
  V3_POSITION_MANAGER_ABI
} from "../lib/abis/uniswap-v3.js";
import {
  LB_PAIR_ABI,
  LB_FACTORY_ABI
} from "../lib/abis/merchant-moe-lb.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type V3Provider = "agni" | "fluxion";
const V3_PROVIDERS = new Set<V3Provider>(["agni", "fluxion"]);

interface TokenInfo {
  address: string;
  symbol: string | null;
  decimals: number | null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function requireAddress(input: unknown, fieldName: string): `0x${string}` {
  if (typeof input !== "string" || !isAddress(input, { strict: false })) {
    throw new MantleMcpError(
      "INVALID_ADDRESS",
      `${fieldName} must be a valid address.`,
      "Provide an EIP-55 address string.",
      { field: fieldName, value: input ?? null }
    );
  }
  return getAddress(input) as `0x${string}`;
}

function requireString(input: unknown, fieldName: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `${fieldName} is required.`,
      `Provide a non-empty string for ${fieldName}.`,
      { field: fieldName }
    );
  }
  return input.trim();
}

function getContractAddress(
  protocol: string,
  contractKey: string,
  network: Network
): `0x${string}` {
  const proto = MANTLE_PROTOCOLS[network]?.[protocol];
  if (!proto) {
    throw new MantleMcpError(
      "UNSUPPORTED_PROTOCOL",
      `Protocol '${protocol}' not found on ${network}.`,
      "Check available protocols.",
      { protocol, network }
    );
  }
  const addr = proto.contracts[contractKey];
  if (!addr || addr.startsWith("BLOCKER")) {
    throw new MantleMcpError(
      "UNSUPPORTED_PROTOCOL",
      `Contract '${contractKey}' for ${protocol} not available on ${network}.`,
      "This contract may not be deployed yet.",
      { protocol, contractKey, network }
    );
  }
  return addr as `0x${string}`;
}

async function resolveTokenInfo(
  identifier: string,
  network: Network
): Promise<TokenInfo> {
  const resolved = await resolveTokenInputFromRegistry(identifier, network);
  return {
    address: resolved.address,
    symbol: resolved.symbol,
    decimals: resolved.decimals
  };
}

function nowUtc(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// V3 price math
// ---------------------------------------------------------------------------

/**
 * Compute human-readable price from sqrtPriceX96.
 *
 * price_token0_per_token1 = (sqrtPriceX96 / 2^96)^2 * 10^(decimals0 - decimals1)
 *
 * We perform the computation in floating point which is sufficient for display.
 */
function priceFromSqrtX96(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number
): { price_token0_per_token1: number; price_token1_per_token0: number } {
  const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
  const rawPrice = sqrtPrice * sqrtPrice; // token1 per token0 in raw terms
  const decimalAdjustment = 10 ** (decimals0 - decimals1);
  const price_token1_per_token0 = rawPrice * decimalAdjustment;
  const price_token0_per_token1 =
    price_token1_per_token0 !== 0 ? 1 / price_token1_per_token0 : 0;
  return { price_token0_per_token1, price_token1_per_token0 };
}

/**
 * Convert a single tick to a human-readable price.
 * price = 1.0001^tick * 10^(decimals0 - decimals1)
 */
function priceFromTick(
  tick: number,
  decimals0: number,
  decimals1: number
): number {
  return Math.pow(1.0001, tick) * 10 ** (decimals0 - decimals1);
}

/**
 * Snap a tick down (floor) to the nearest multiple of tickSpacing.
 */
function snapTickFloor(tick: number, tickSpacing: number): number {
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

/**
 * Snap a tick up (ceil) to the nearest multiple of tickSpacing.
 */
function snapTickCeil(tick: number, tickSpacing: number): number {
  return Math.ceil(tick / tickSpacing) * tickSpacing;
}

// =========================================================================
// Tool 1: mantle_getV3PoolState
// =========================================================================

export async function getV3PoolState(
  args: Record<string, unknown>
): Promise<unknown> {
  const { network } = normalizeNetwork(args);
  const client = getPublicClient(network);

  let poolAddress: `0x${string}`;
  let provider: V3Provider | null = null;

  // --- Resolve pool address ---
  if (args.pool_address && typeof args.pool_address === "string") {
    poolAddress = requireAddress(args.pool_address, "pool_address");
    if (args.provider && typeof args.provider === "string") {
      const p = args.provider.toLowerCase();
      if (V3_PROVIDERS.has(p as V3Provider)) {
        provider = p as V3Provider;
      }
    }
  } else {
    // Resolve via factory
    const tokenAInput = requireString(args.token_a, "token_a");
    const tokenBInput = requireString(args.token_b, "token_b");
    const feeTier = args.fee_tier;
    if (feeTier == null || typeof feeTier !== "number") {
      throw new MantleMcpError(
        "INVALID_INPUT",
        "fee_tier is required when pool_address is not provided.",
        "Provide fee_tier (e.g. 500, 3000, 10000).",
        { field: "fee_tier" }
      );
    }
    const providerInput = requireString(args.provider, "provider").toLowerCase();
    if (!V3_PROVIDERS.has(providerInput as V3Provider)) {
      throw new MantleMcpError(
        "INVALID_INPUT",
        `provider must be 'agni' or 'fluxion' for V3 pool lookup.`,
        "Use provider='agni' or provider='fluxion'.",
        { provider: providerInput }
      );
    }
    provider = providerInput as V3Provider;

    const [tokenAInfo, tokenBInfo] = await Promise.all([
      resolveTokenInfo(tokenAInput, network),
      resolveTokenInfo(tokenBInput, network)
    ]);

    const factoryAddress = getContractAddress(provider, "factory", network);
    const resolvedPool = await client.readContract({
      address: factoryAddress,
      abi: V3_FACTORY_ABI,
      functionName: "getPool",
      args: [
        tokenAInfo.address as `0x${string}`,
        tokenBInfo.address as `0x${string}`,
        feeTier
      ]
    });

    poolAddress = resolvedPool as `0x${string}`;

    if (
      !poolAddress ||
      poolAddress === "0x0000000000000000000000000000000000000000"
    ) {
      throw new MantleMcpError(
        "POOL_NOT_FOUND",
        `No ${provider} V3 pool found for ${tokenAInput}/${tokenBInput} at fee tier ${feeTier}.`,
        "Verify the token pair and fee tier, or provide a pool_address directly.",
        { token_a: tokenAInput, token_b: tokenBInput, fee_tier: feeTier, provider }
      );
    }
  }

  // --- Multicall: read pool state ---
  const poolCalls = [
    { address: poolAddress, abi: V3_POOL_ABI, functionName: "slot0" as const },
    { address: poolAddress, abi: V3_POOL_ABI, functionName: "liquidity" as const },
    { address: poolAddress, abi: V3_POOL_ABI, functionName: "token0" as const },
    { address: poolAddress, abi: V3_POOL_ABI, functionName: "token1" as const },
    { address: poolAddress, abi: V3_POOL_ABI, functionName: "fee" as const },
    { address: poolAddress, abi: V3_POOL_ABI, functionName: "tickSpacing" as const }
  ];

  const results = await client.multicall({ contracts: poolCalls });

  // Validate all calls succeeded
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "failure") {
      throw new MantleMcpError(
        "RPC_ERROR",
        `Failed to read pool state from ${poolAddress}. The address may not be a valid V3 pool.`,
        "Verify the pool address is a deployed Uniswap V3-compatible pool.",
        { pool_address: poolAddress, failed_call_index: i }
      );
    }
  }

  const slot0 = results[0].result as readonly [bigint, number, number, number, number, number, boolean];
  const poolLiquidity = results[1].result as bigint;
  const token0Addr = results[2].result as `0x${string}`;
  const token1Addr = results[3].result as `0x${string}`;
  const poolFee = results[4].result as number;
  const tickSpacing = results[5].result as number;

  const sqrtPriceX96 = slot0[0];
  const currentTick = slot0[1];

  // Resolve token metadata
  const [token0Info, token1Info] = await Promise.all([
    resolveTokenInfo(token0Addr, network),
    resolveTokenInfo(token1Addr, network)
  ]);

  const decimals0 = token0Info.decimals ?? 18;
  const decimals1 = token1Info.decimals ?? 18;
  const prices = priceFromSqrtX96(sqrtPriceX96, decimals0, decimals1);

  return {
    pool_address: poolAddress,
    provider: provider ?? "unknown",
    token0: {
      address: token0Info.address,
      symbol: token0Info.symbol,
      decimals: token0Info.decimals
    },
    token1: {
      address: token1Info.address,
      symbol: token1Info.symbol,
      decimals: token1Info.decimals
    },
    sqrt_price_x96: sqrtPriceX96.toString(),
    current_tick: currentTick,
    tick_spacing: tickSpacing,
    fee: poolFee,
    pool_liquidity: poolLiquidity.toString(),
    price_token0_per_token1: prices.price_token0_per_token1,
    price_token1_per_token0: prices.price_token1_per_token0,
    queried_at_utc: nowUtc()
  };
}

// =========================================================================
// Tool 2: mantle_getLBPairState
// =========================================================================

export async function getLBPairState(
  args: Record<string, unknown>
): Promise<unknown> {
  const { network } = normalizeNetwork(args);
  const client = getPublicClient(network);

  let pairAddress: `0x${string}`;

  // --- Resolve pair address ---
  if (args.pair_address && typeof args.pair_address === "string") {
    pairAddress = requireAddress(args.pair_address, "pair_address");
  } else {
    const tokenAInput = requireString(args.token_a, "token_a");
    const tokenBInput = requireString(args.token_b, "token_b");
    const binStep = args.bin_step;
    if (binStep == null || typeof binStep !== "number") {
      throw new MantleMcpError(
        "INVALID_INPUT",
        "bin_step is required when pair_address is not provided.",
        "Provide bin_step (e.g. 1, 5, 10, 15, 20, 25).",
        { field: "bin_step" }
      );
    }

    const [tokenAInfo, tokenBInfo] = await Promise.all([
      resolveTokenInfo(tokenAInput, network),
      resolveTokenInfo(tokenBInput, network)
    ]);

    const factoryAddress = getContractAddress(
      "merchant_moe",
      "lb_factory_v2_2",
      network
    );

    const pairInfo = (await client.readContract({
      address: factoryAddress,
      abi: LB_FACTORY_ABI,
      functionName: "getLBPairInformation",
      args: [
        tokenAInfo.address as `0x${string}`,
        tokenBInfo.address as `0x${string}`,
        BigInt(binStep)
      ]
    })) as { binStep: number; LBPair: `0x${string}`; createdByOwner: boolean; ignoredForRouting: boolean };

    pairAddress = pairInfo.LBPair;

    if (
      !pairAddress ||
      pairAddress === "0x0000000000000000000000000000000000000000"
    ) {
      throw new MantleMcpError(
        "POOL_NOT_FOUND",
        `No Merchant Moe LB pair found for ${tokenAInput}/${tokenBInput} at bin step ${binStep}.`,
        "Verify the token pair and bin step, or provide a pair_address directly.",
        { token_a: tokenAInput, token_b: tokenBInput, bin_step: binStep }
      );
    }
  }

  // --- Read core pair state ---
  const coreCalls = [
    { address: pairAddress, abi: LB_PAIR_ABI, functionName: "getActiveId" as const },
    { address: pairAddress, abi: LB_PAIR_ABI, functionName: "getTokenX" as const },
    { address: pairAddress, abi: LB_PAIR_ABI, functionName: "getTokenY" as const },
    { address: pairAddress, abi: LB_PAIR_ABI, functionName: "getBinStep" as const }
  ];

  const coreResults = await client.multicall({ contracts: coreCalls });

  for (let i = 0; i < coreResults.length; i++) {
    if (coreResults[i].status === "failure") {
      throw new MantleMcpError(
        "RPC_ERROR",
        `Failed to read LB pair state from ${pairAddress}. The address may not be a valid LB pair.`,
        "Verify the pair address is a deployed Merchant Moe Liquidity Book pair.",
        { pair_address: pairAddress, failed_call_index: i }
      );
    }
  }

  const activeId = coreResults[0].result as number;
  const tokenXAddr = coreResults[1].result as `0x${string}`;
  const tokenYAddr = coreResults[2].result as `0x${string}`;
  const binStep = coreResults[3].result as number;

  // Resolve token metadata
  const [tokenXInfo, tokenYInfo] = await Promise.all([
    resolveTokenInfo(tokenXAddr, network),
    resolveTokenInfo(tokenYAddr, network)
  ]);

  // --- Read active +-5 bins (11 total) ---
  const BIN_RADIUS = 5;
  const binIds: number[] = [];
  for (let offset = -BIN_RADIUS; offset <= BIN_RADIUS; offset++) {
    const id = activeId + offset;
    if (id >= 0) {
      binIds.push(id);
    }
  }

  const binCalls = binIds.map((id) => ({
    address: pairAddress,
    abi: LB_PAIR_ABI,
    functionName: "getBin" as const,
    args: [id] as const
  }));

  const binResults = await client.multicall({ contracts: binCalls });

  const decimalsX = tokenXInfo.decimals ?? 18;
  const decimalsY = tokenYInfo.decimals ?? 18;

  const nearbyBins = binIds.map((id, i) => {
    const res = binResults[i];
    if (res.status === "failure") {
      return {
        id,
        reserve_x: "0",
        reserve_y: "0",
        reserve_x_decimal: "0",
        reserve_y_decimal: "0",
        is_active: id === activeId
      };
    }
    const [reserveX, reserveY] = res.result as readonly [bigint, bigint];
    return {
      id,
      reserve_x: reserveX.toString(),
      reserve_y: reserveY.toString(),
      reserve_x_decimal: formatUnits(reserveX, decimalsX),
      reserve_y_decimal: formatUnits(reserveY, decimalsY),
      is_active: id === activeId
    };
  });

  // Active bin reserves
  const activeBin = nearbyBins.find((b) => b.is_active);

  return {
    pair_address: pairAddress,
    token_x: {
      address: tokenXInfo.address,
      symbol: tokenXInfo.symbol,
      decimals: tokenXInfo.decimals
    },
    token_y: {
      address: tokenYInfo.address,
      symbol: tokenYInfo.symbol,
      decimals: tokenYInfo.decimals
    },
    active_id: activeId,
    bin_step: binStep,
    active_bin: activeBin
      ? {
          reserve_x: activeBin.reserve_x,
          reserve_y: activeBin.reserve_y,
          reserve_x_decimal: activeBin.reserve_x_decimal,
          reserve_y_decimal: activeBin.reserve_y_decimal
        }
      : null,
    nearby_bins: nearbyBins,
    queried_at_utc: nowUtc()
  };
}

// =========================================================================
// Tool 3: mantle_getV3Positions
// =========================================================================

const MAX_POSITIONS_PER_PROVIDER = 50;

interface PositionResult {
  token_id: string;
  provider: V3Provider;
  token0: TokenInfo;
  token1: TokenInfo;
  fee: number;
  tick_lower: number;
  tick_upper: number;
  liquidity: string;
  tokens_owed0: string;
  tokens_owed1: string;
  in_range: boolean;
}

async function readPositionsForProvider(
  provider: V3Provider,
  owner: `0x${string}`,
  network: Network,
  includeEmpty: boolean
): Promise<PositionResult[]> {
  const client = getPublicClient(network);
  const positionManager = getContractAddress(
    provider,
    "position_manager",
    network
  );

  // Step 1: Get balance (number of NFTs)
  const balance = await client.readContract({
    address: positionManager,
    abi: V3_POSITION_MANAGER_ABI,
    functionName: "balanceOf",
    args: [owner]
  });

  const count = Number(balance);
  if (count === 0) return [];

  const cappedCount = Math.min(count, MAX_POSITIONS_PER_PROVIDER);

  // Step 2: Get all token IDs via multicall
  const indexCalls = Array.from({ length: cappedCount }, (_, i) => ({
    address: positionManager,
    abi: V3_POSITION_MANAGER_ABI,
    functionName: "tokenOfOwnerByIndex" as const,
    args: [owner, BigInt(i)] as const
  }));

  const indexResults = await client.multicall({ contracts: indexCalls });

  const tokenIds: bigint[] = [];
  for (const res of indexResults) {
    if (res.status === "success") {
      tokenIds.push(res.result as bigint);
    }
  }

  if (tokenIds.length === 0) return [];

  // Step 3: Read all positions via multicall
  const positionCalls = tokenIds.map((tokenId) => ({
    address: positionManager,
    abi: V3_POSITION_MANAGER_ABI,
    functionName: "positions" as const,
    args: [tokenId] as const
  }));

  const positionResults = await client.multicall({ contracts: positionCalls });

  // Step 4: Collect unique pools to read slot0 for in_range checks
  const poolKeys = new Map<
    string,
    { token0: `0x${string}`; token1: `0x${string}`; fee: number }
  >();
  const rawPositions: Array<{
    tokenId: bigint;
    token0: `0x${string}`;
    token1: `0x${string}`;
    fee: number;
    tickLower: number;
    tickUpper: number;
    liquidity: bigint;
    tokensOwed0: bigint;
    tokensOwed1: bigint;
  }> = [];

  for (let i = 0; i < positionResults.length; i++) {
    const res = positionResults[i];
    if (res.status !== "success") continue;

    const r = res.result as readonly [
      bigint, string, string, string, number, number, number,
      bigint, bigint, bigint, bigint, bigint
    ];

    const liquidity = r[7];
    const tokensOwed0 = r[10];
    const tokensOwed1 = r[11];

    // Filter zero-liquidity unless include_empty
    if (!includeEmpty && liquidity === 0n && tokensOwed0 === 0n && tokensOwed1 === 0n) {
      continue;
    }

    const token0 = r[2] as `0x${string}`;
    const token1 = r[3] as `0x${string}`;
    const fee = r[4];
    const poolKey = `${token0}-${token1}-${fee}`.toLowerCase();

    poolKeys.set(poolKey, { token0, token1, fee });
    rawPositions.push({
      tokenId: tokenIds[i],
      token0,
      token1,
      fee,
      tickLower: r[5],
      tickUpper: r[6],
      liquidity,
      tokensOwed0,
      tokensOwed1
    });
  }

  if (rawPositions.length === 0) return [];

  // Step 5: Resolve pool addresses and read current ticks
  const factoryAddress = getContractAddress(provider, "factory", network);
  const poolEntries = Array.from(poolKeys.entries());

  const poolLookupCalls = poolEntries.map(([, { token0, token1, fee }]) => ({
    address: factoryAddress,
    abi: V3_FACTORY_ABI,
    functionName: "getPool" as const,
    args: [token0, token1, fee] as const
  }));

  const poolLookupResults = await client.multicall({
    contracts: poolLookupCalls
  });

  const poolAddresses = new Map<string, `0x${string}`>();
  for (let i = 0; i < poolEntries.length; i++) {
    if (poolLookupResults[i].status === "success") {
      const addr = poolLookupResults[i].result as `0x${string}`;
      if (addr !== "0x0000000000000000000000000000000000000000") {
        poolAddresses.set(poolEntries[i][0], addr);
      }
    }
  }

  // Read slot0 for each unique pool
  const uniquePoolAddrs = Array.from(new Set(poolAddresses.values()));
  const slot0Calls = uniquePoolAddrs.map((addr) => ({
    address: addr,
    abi: V3_POOL_ABI,
    functionName: "slot0" as const
  }));

  const slot0Results =
    uniquePoolAddrs.length > 0
      ? await client.multicall({ contracts: slot0Calls })
      : [];

  const poolTicks = new Map<string, number>();
  for (let i = 0; i < uniquePoolAddrs.length; i++) {
    if (slot0Results[i]?.status === "success") {
      const slot0 = slot0Results[i].result as readonly [bigint, number, ...unknown[]];
      poolTicks.set(uniquePoolAddrs[i].toLowerCase(), slot0[1]);
    }
  }

  // Step 6: Resolve token metadata (unique addresses only)
  const uniqueTokenAddrs = new Set<string>();
  for (const pos of rawPositions) {
    uniqueTokenAddrs.add(pos.token0);
    uniqueTokenAddrs.add(pos.token1);
  }
  const tokenEntries = Array.from(uniqueTokenAddrs);
  const tokenInfoResults = await Promise.all(
    tokenEntries.map((addr) => resolveTokenInfo(addr, network))
  );
  const tokenInfoMap = new Map<string, TokenInfo>();
  for (let i = 0; i < tokenEntries.length; i++) {
    tokenInfoMap.set(tokenEntries[i].toLowerCase(), tokenInfoResults[i]);
  }

  // Step 7: Build result
  const positions: PositionResult[] = rawPositions.map((pos) => {
    const poolKey = `${pos.token0}-${pos.token1}-${pos.fee}`.toLowerCase();
    const poolAddr = poolAddresses.get(poolKey);
    const currentTick = poolAddr
      ? poolTicks.get(poolAddr.toLowerCase())
      : undefined;

    const inRange =
      currentTick != null
        ? currentTick >= pos.tickLower && currentTick < pos.tickUpper
        : false;

    const t0 = tokenInfoMap.get(pos.token0.toLowerCase()) ?? {
      address: pos.token0,
      symbol: null,
      decimals: null
    };
    const t1 = tokenInfoMap.get(pos.token1.toLowerCase()) ?? {
      address: pos.token1,
      symbol: null,
      decimals: null
    };

    return {
      token_id: pos.tokenId.toString(),
      provider,
      token0: t0,
      token1: t1,
      fee: pos.fee,
      tick_lower: pos.tickLower,
      tick_upper: pos.tickUpper,
      liquidity: pos.liquidity.toString(),
      tokens_owed0: pos.tokensOwed0.toString(),
      tokens_owed1: pos.tokensOwed1.toString(),
      in_range: inRange
    };
  });

  return positions;
}

export async function getV3Positions(
  args: Record<string, unknown>
): Promise<unknown> {
  const { network } = normalizeNetwork(args);
  const owner = requireAddress(args.owner, "owner");
  const includeEmpty = args.include_empty === true;

  // Determine which providers to scan
  let providers: V3Provider[] = ["agni", "fluxion"];
  if (args.provider && typeof args.provider === "string") {
    const p = args.provider.toLowerCase();
    if (V3_PROVIDERS.has(p as V3Provider)) {
      providers = [p as V3Provider];
    } else {
      throw new MantleMcpError(
        "INVALID_INPUT",
        `provider must be 'agni' or 'fluxion'.`,
        "Use provider='agni', provider='fluxion', or omit to scan both.",
        { provider: args.provider }
      );
    }
  }

  const allPositions: PositionResult[] = [];
  const errors: Array<{ provider: string; error: string }> = [];

  // Scan each provider
  const results = await Promise.allSettled(
    providers.map((p) => readPositionsForProvider(p, owner, network, includeEmpty))
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      allPositions.push(...result.value);
    } else {
      errors.push({
        provider: providers[i],
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
      });
    }
  }

  return {
    owner,
    network,
    total_positions: allPositions.length,
    positions: allPositions,
    errors: errors.length > 0 ? errors : undefined,
    include_empty: includeEmpty,
    queried_at_utc: nowUtc()
  };
}

// =========================================================================
// Tool 4: mantle_suggestTickRange
// =========================================================================

interface TickRangeSuggestion {
  strategy: string;
  description: string;
  tick_lower: number;
  tick_upper: number;
  price_lower: number;
  price_upper: number;
  tick_count: number;
}

export async function suggestTickRange(
  args: Record<string, unknown>
): Promise<unknown> {
  // Reuse getV3PoolState logic to fetch pool state
  const poolState = (await getV3PoolState(args)) as {
    pool_address: string;
    provider: string;
    token0: TokenInfo;
    token1: TokenInfo;
    sqrt_price_x96: string;
    current_tick: number;
    tick_spacing: number;
    fee: number;
    pool_liquidity: string;
    price_token0_per_token1: number;
    price_token1_per_token0: number;
    queried_at_utc: string;
  };

  const currentTick = poolState.current_tick;
  const tickSpacing = poolState.tick_spacing;
  const decimals0 = poolState.token0.decimals ?? 18;
  const decimals1 = poolState.token1.decimals ?? 18;

  const strategies: Array<{
    name: string;
    description: string;
    multiplier: number;
  }> = [
    {
      name: "wide",
      description:
        "Wide range: captures large price moves, lower capital efficiency. Good for volatile pairs or passive LPs.",
      multiplier: 200
    },
    {
      name: "moderate",
      description:
        "Moderate range: balanced capital efficiency vs. rebalance frequency. Good for most pairs.",
      multiplier: 50
    },
    {
      name: "tight",
      description:
        "Tight range: highest capital efficiency, requires frequent rebalancing. Best for stable pairs or active managers.",
      multiplier: 10
    }
  ];

  const suggestions: TickRangeSuggestion[] = strategies.map(
    ({ name, description, multiplier }) => {
      const rawLower = currentTick - multiplier * tickSpacing;
      const rawUpper = currentTick + multiplier * tickSpacing;
      const tickLower = snapTickFloor(rawLower, tickSpacing);
      const tickUpper = snapTickCeil(rawUpper, tickSpacing);
      const priceLower = priceFromTick(tickLower, decimals0, decimals1);
      const priceUpper = priceFromTick(tickUpper, decimals0, decimals1);
      const tickCount = (tickUpper - tickLower) / tickSpacing;

      return {
        strategy: name,
        description,
        tick_lower: tickLower,
        tick_upper: tickUpper,
        price_lower: priceLower,
        price_upper: priceUpper,
        tick_count: tickCount
      };
    }
  );

  return {
    pool_address: poolState.pool_address,
    provider: poolState.provider,
    token0: poolState.token0,
    token1: poolState.token1,
    fee: poolState.fee,
    current_tick: currentTick,
    tick_spacing: tickSpacing,
    current_price_token1_per_token0: poolState.price_token1_per_token0,
    current_price_token0_per_token1: poolState.price_token0_per_token1,
    suggestions,
    note: "Prices shown as token1 per token0 (the standard V3 convention). price_lower/price_upper correspond to tick_lower/tick_upper respectively.",
    queried_at_utc: nowUtc()
  };
}

// =========================================================================
// Exported tool record
// =========================================================================

export const defiLpReadTools: Record<string, Tool> = {
  mantle_getV3PoolState: {
    name: "mantle_getV3PoolState",
    description:
      "Read on-chain state of a Uniswap V3-compatible pool (Agni Finance or Fluxion) on Mantle. Returns sqrtPriceX96, current tick, tick spacing, liquidity, and human-readable prices.\n\nResolve by pool_address directly, or by (token_a + token_b + fee_tier + provider) to look up via the factory.\n\nExamples:\n- By address: pool_address='0xABC...'\n- By pair: token_a='WMNT', token_b='USDC', fee_tier=3000, provider='agni'",
    inputSchema: {
      type: "object",
      properties: {
        pool_address: {
          type: "string",
          description:
            "V3 pool contract address. If provided, token_a/token_b/fee_tier/provider are optional."
        },
        token_a: {
          type: "string",
          description:
            "First token symbol or address. Required if pool_address is not given."
        },
        token_b: {
          type: "string",
          description:
            "Second token symbol or address. Required if pool_address is not given."
        },
        fee_tier: {
          type: "number",
          description:
            "V3 fee tier in hundredths of a bip (500=0.05%, 3000=0.3%, 10000=1%). Required if pool_address is not given."
        },
        provider: {
          type: "string",
          description:
            "DEX provider: 'agni' or 'fluxion'. Required if pool_address is not given; optional hint when pool_address is given."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: []
    },
    handler: getV3PoolState
  },

  mantle_getLBPairState: {
    name: "mantle_getLBPairState",
    description:
      "Read on-chain state of a Merchant Moe Liquidity Book pair on Mantle. Returns active bin ID, bin step, token metadata, active bin reserves, and reserves for +-5 nearby bins.\n\nResolve by pair_address directly, or by (token_a + token_b + bin_step) to look up via the LB Factory.\n\nExamples:\n- By address: pair_address='0xDEF...'\n- By pair: token_a='WMNT', token_b='USDC', bin_step=20",
    inputSchema: {
      type: "object",
      properties: {
        pair_address: {
          type: "string",
          description:
            "LB pair contract address. If provided, token_a/token_b/bin_step are optional."
        },
        token_a: {
          type: "string",
          description:
            "First token symbol or address. Required if pair_address is not given."
        },
        token_b: {
          type: "string",
          description:
            "Second token symbol or address. Required if pair_address is not given."
        },
        bin_step: {
          type: "number",
          description:
            "LB bin step (e.g. 1, 5, 10, 15, 20, 25). Required if pair_address is not given."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: []
    },
    handler: getLBPairState
  },

  mantle_getV3Positions: {
    name: "mantle_getV3Positions",
    description:
      "Enumerate all V3 LP positions for a wallet across Agni Finance and Fluxion on Mantle. Returns token IDs, tick ranges, liquidity, uncollected fees, and whether each position is in-range.\n\nBy default filters out zero-liquidity, zero-fees positions (set include_empty=true to show all).\n\nExamples:\n- All positions: owner='0x1234...'\n- Agni only: owner='0x1234...', provider='agni'\n- Include empty: owner='0x1234...', include_empty=true",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Wallet address to enumerate LP positions for."
        },
        provider: {
          type: "string",
          description:
            "Optional filter: 'agni' or 'fluxion'. Omit to scan both."
        },
        include_empty: {
          type: "boolean",
          description:
            "Include zero-liquidity and zero-fees positions (default: false)."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["owner"]
    },
    handler: getV3Positions
  },

  mantle_suggestTickRange: {
    name: "mantle_suggestTickRange",
    description:
      "Suggest tick ranges for a V3 LP position on Mantle (Agni or Fluxion). Reads current pool state and generates three strategies (wide/moderate/tight) with tick bounds snapped to the pool's tick spacing grid and corresponding prices.\n\nAccepts the same inputs as mantle_getV3PoolState: pool_address OR (token_a + token_b + fee_tier + provider).\n\nExamples:\n- By address: pool_address='0xABC...'\n- By pair: token_a='WMNT', token_b='USDC', fee_tier=3000, provider='agni'",
    inputSchema: {
      type: "object",
      properties: {
        pool_address: {
          type: "string",
          description:
            "V3 pool contract address. If provided, token_a/token_b/fee_tier/provider are optional."
        },
        token_a: {
          type: "string",
          description:
            "First token symbol or address. Required if pool_address is not given."
        },
        token_b: {
          type: "string",
          description:
            "Second token symbol or address. Required if pool_address is not given."
        },
        fee_tier: {
          type: "number",
          description:
            "V3 fee tier (500, 3000, 10000). Required if pool_address is not given."
        },
        provider: {
          type: "string",
          description:
            "DEX provider: 'agni' or 'fluxion'. Required if pool_address is not given."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: []
    },
    handler: suggestTickRange
  }
};
