/**
 * Unit tests for buildSwap.
 *
 * Coverage:
 *   - V3 (agni/fluxion) single-hop with explicit fee_tier — calldata, to, value, intent
 *   - V3 auto pool discovery (no fee_tier) — discoverBestV3Pool via d.getClient
 *   - V3 multi-hop route (no direct pool, bridge via WMNT)
 *   - Merchant Moe LB single-hop with explicit bin_step
 *   - Merchant Moe LB — on-chain quoter discovery (no bin_step)
 *   - Error paths: MISSING_SLIPPAGE_PROTECTION, INVALID_AMOUNT_FORMAT,
 *     INSUFFICIENT_ALLOWANCE, QUOTE_BUILD_MISMATCH, XSTOCKS_FLUXION_ONLY,
 *     NO_ROUTE_FOUND
 *
 * Uses deps injection only — no vi.mock() required.
 * (buildSwap only calls getPublicClient indirectly via d.getClient.)
 */
import { describe, expect, it } from "vitest";
import { buildSwap } from "@mantleio/mantle-core/tools/defi-write.js";
import { MantleMcpError } from "@mantleio/mantle-core/errors.js";

// ── Contract addresses ─────────────────────────────────────────────────────
const AGNI_ROUTER    = "0x319B69888b0d11cEC22caA5034e25FfFBDc88421";
const FLUXION_ROUTER = "0x5628a59dF0ECAC3f3171f877A94bEb26BA6DFAa0";
const AGNI_FACTORY   = "0x25780dc8Fc3cfBD75F33bFDAB65e969b603b2035";
const LB_ROUTER      = "0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a";
const LB_FACTORY     = "0xa6630671775c4EA2743840F9A5016dCf2A104054";
const LB_QUOTER      = "0x501b8AFd35df20f531fF45F6f695793AC3316c85";

// ── Token addresses ────────────────────────────────────────────────────────
const WMNT  = "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8";
const USDC  = "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9";
const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const WETH  = "0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111";
const FAKE_POOL = "0xBEEF000000000000000000000000000000000001";
const FAKE_WALLET    = "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF";
const FAKE_RECIPIENT = "0x1111111111111111111111111111111111111111";

// ── ABI selectors ──────────────────────────────────────────────────────────
// keccak256("exactInputSingle(...)")[0:4]
const SELECTOR_EXACT_INPUT_SINGLE = "0x414bf389";
// keccak256("exactInput(...)")[0:4]
const SELECTOR_EXACT_INPUT = "0xc04b8d59";
// keccak256("swapExactTokensForTokens(...)")[0:4] — LB Router
// Computed from LB Router ABI function swapExactTokensForTokens
const SELECTOR_SWAP_EXACT_TOKENS = "0x38ed1739"; // standard Uni V2 selector used by Moe

// ── Shared deps ────────────────────────────────────────────────────────────
const NOW = "2026-01-01T00:00:00.000Z";

/** Minimal token map for resolveTokenInput */
function makeResolveToken(overrides: Record<string, { symbol: string; decimals: number }> = {}) {
  const defaults: Record<string, { symbol: string; decimals: number }> = {
    "wmnt":  { symbol: "WMNT",  decimals: 18 },
    "usdc":  { symbol: "USDC",  decimals: 6  },
    "usdt0": { symbol: "USDT0", decimals: 6  },
    "weth":  { symbol: "WETH",  decimals: 18 },
    [WMNT.toLowerCase()]:  { symbol: "WMNT",  decimals: 18 },
    [USDC.toLowerCase()]:  { symbol: "USDC",  decimals: 6  },
    [USDT0.toLowerCase()]: { symbol: "USDT0", decimals: 6  },
    [WETH.toLowerCase()]:  { symbol: "WETH",  decimals: 18 },
    ...overrides
  };
  return async (input: string) => {
    const key = input.toLowerCase();
    const row = defaults[key];
    if (!row) throw new Error(`resolveTokenInput: unknown '${input}'`);
    // Return the canonical checksummed address for symbol inputs
    const addressMap: Record<string, string> = {
      wmnt: WMNT, usdc: USDC, usdt0: USDT0, weth: WETH,
      [WMNT.toLowerCase()]: WMNT, [USDC.toLowerCase()]: USDC,
      [USDT0.toLowerCase()]: USDT0, [WETH.toLowerCase()]: WETH
    };
    return { address: addressMap[key] ?? input, ...row };
  };
}

const baseDeps = {
  now: () => NOW,
  deadline: () => 9_999_999_999n,
  resolveTokenInput: makeResolveToken()
};

// ── No-RPC client (throws on any readContract call) ────────────────────────
const noRpcClient = () => ({
  readContract: async () => { throw new Error("unexpected readContract"); }
});

// =========================================================================
// V3 swap — explicit fee_tier (bypasses on-chain discovery)
// =========================================================================
describe("buildSwap — V3 agni, explicit fee_tier", () => {
  const swapArgs = {
    provider: "agni",
    token_in: "WMNT",
    token_out: "USDC",
    amount_in: "10",
    amount_out_min: "8000000", // 8 USDC raw
    fee_tier: 3000,
    recipient: FAKE_RECIPIENT
  };

  it("to=agni router, value=0x0, data starts with exactInputSingle selector", async () => {
    const result = await buildSwap(swapArgs, {
      ...baseDeps,
      getClient: noRpcClient as any
    });
    expect(result.unsigned_tx.to).toBe(AGNI_ROUTER);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.data.startsWith(SELECTOR_EXACT_INPUT_SINGLE)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
  });

  it("intent=swap, pool_params.provider=agni, pool_params.fee_tier=3000", async () => {
    const result = await buildSwap(swapArgs, {
      ...baseDeps,
      getClient: noRpcClient as any
    });
    expect(result.intent).toBe("swap");
    expect(result.pool_params?.provider).toBe("agni");
    expect(result.pool_params?.fee_tier).toBe(3000);
    expect(result.pool_params?.router_address).toBe(AGNI_ROUTER);
  });

  it("token_info populated with in/out token metadata", async () => {
    const result = await buildSwap(swapArgs, {
      ...baseDeps,
      getClient: noRpcClient as any
    });
    expect(result.token_info?.token_in?.symbol).toBe("WMNT");
    expect(result.token_info?.token_out?.symbol).toBe("USDC");
    expect(result.token_info?.token_in?.decimals).toBe(18);
    expect(result.token_info?.token_out?.decimals).toBe(6);
  });

  it("slippage_protection echo populated when amount_out_min provided", async () => {
    const result = await buildSwap(swapArgs, {
      ...baseDeps,
      getClient: noRpcClient as any
    });
    expect(result.slippage_protection).toBeDefined();
    expect(result.slippage_protection?.resolved_raw).toBe("8000000");
  });
});

describe("buildSwap — V3 fluxion, explicit fee_tier", () => {
  it("to=fluxion router, not agni router", async () => {
    const result = await buildSwap(
      {
        provider: "fluxion",
        token_in: "WMNT",
        token_out: "USDC",
        amount_in: "10",
        amount_out_min: "8000000",
        fee_tier: 3000,
        recipient: FAKE_RECIPIENT
      },
      { ...baseDeps, getClient: noRpcClient as any }
    );
    expect(result.unsigned_tx.to).toBe(FLUXION_ROUTER);
    expect(result.unsigned_tx.to).not.toBe(AGNI_ROUTER);
  });
});

// =========================================================================
// V3 swap — auto pool discovery (no fee_tier provided)
// =========================================================================
describe("buildSwap — V3 agni, auto pool discovery", () => {
  /**
   * discoverBestV3Pool calls d.getClient(network) and then:
   *   1. calls factory.getPool(tokenA, tokenB, feeTier) for each fee tier
   *   2. for non-zero pools, calls pool.liquidity()
   *
   * We mock readContract to return a fake pool address only for fee_tier=500
   * and a liquidity > 0.
   */
  function makeDiscoveryClient() {
    return () => ({
      readContract: async ({ address, functionName, args }: any) => {
        // Factory getPool calls
        if (functionName === "getPool" || functionName === "getPair") {
          const feeTier = Number(args[2]);
          if (feeTier === 500) return FAKE_POOL; // pool exists at 500bps
          return "0x0000000000000000000000000000000000000000"; // no pool at other tiers
        }
        // Pool liquidity call
        if (functionName === "liquidity") {
          if (address === FAKE_POOL) return 1_000_000_000_000n; // non-zero liquidity
          return 0n;
        }
        // Allowance check (not needed here — no owner)
        return 0n;
      },
      // discoverBestV3Pool uses multicall for batched factory + liquidity reads
      multicall: async ({ contracts }: { contracts: Array<any> }) => {
        return contracts.map(({ address, functionName, args }: any) => {
          if (functionName === "getPool" || functionName === "getPair") {
            const feeTier = Number(args[2]);
            const pool = feeTier === 500 ? FAKE_POOL : "0x0000000000000000000000000000000000000000";
            return { status: "success" as const, result: pool };
          }
          if (functionName === "liquidity") {
            const liq = (address as string).toLowerCase() === FAKE_POOL.toLowerCase()
              ? 1_000_000_000_000n : 0n;
            return { status: "success" as const, result: liq };
          }
          return { status: "success" as const, result: "0x0000000000000000000000000000000000000000" };
        });
      }
    });
  }

  it("discovers fee_tier=500 from on-chain, builds exactInputSingle calldata", async () => {
    const result = await buildSwap(
      {
        provider: "agni",
        token_in: "WMNT",
        token_out: "USDC",
        amount_in: "10",
        amount_out_min: "8000000",
        recipient: FAKE_RECIPIENT
        // no fee_tier — auto-discover
      },
      { ...baseDeps, getClient: makeDiscoveryClient() as any }
    );
    expect(result.unsigned_tx.to).toBe(AGNI_ROUTER);
    expect(result.unsigned_tx.data.startsWith(SELECTOR_EXACT_INPUT_SINGLE)).toBe(true);
    expect(result.pool_params?.fee_tier).toBe(500);
  });

  it("all fee tiers return zero pool → tries multihop → if no bridge either → NO_ROUTE_FOUND", async () => {
    const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
    const allZeroClient = () => ({
      readContract: async () => ZERO_ADDR,
      multicall: async ({ contracts }: { contracts: Array<any> }) =>
        contracts.map(() => ({ status: "success" as const, result: ZERO_ADDR }))
    });
    await expect(
      buildSwap(
        {
          provider: "agni",
          token_in: "WMNT",
          token_out: "USDC",
          amount_in: "10",
          amount_out_min: "8000000",
          recipient: FAKE_RECIPIENT
        },
        { ...baseDeps, getClient: allZeroClient as any }
      )
    ).rejects.toMatchObject({ code: "NO_ROUTE_FOUND" });
  });
});

// =========================================================================
// V3 multi-hop route
// =========================================================================
describe("buildSwap — V3 agni, multi-hop route", () => {
  /**
   * Simulate: WETH↔USDC has no direct pool, but routes via WMNT bridge:
   *   WETH → WMNT (fee 500) → USDC (fee 3000)
   */
  function makeMultihopClient() {
    const pools: Record<string, { address: string; liquidity: bigint }> = {
      // WETH/WMNT pool at 500
      [`${WETH.toLowerCase()}-${WMNT.toLowerCase()}-500`]: { address: "0xBEEF100000000000000000000000000000000001", liquidity: 5_000_000n },
      [`${WMNT.toLowerCase()}-${WETH.toLowerCase()}-500`]: { address: "0xBEEF100000000000000000000000000000000001", liquidity: 5_000_000n },
      // WMNT/USDC pool at 3000
      [`${WMNT.toLowerCase()}-${USDC.toLowerCase()}-3000`]: { address: "0xBEEF200000000000000000000000000000000002", liquidity: 10_000_000n },
      [`${USDC.toLowerCase()}-${WMNT.toLowerCase()}-3000`]: { address: "0xBEEF200000000000000000000000000000000002", liquidity: 10_000_000n }
    };
    const resolvePool = (address: string, functionName: string, args: any) => {
      if (functionName === "getPool" || functionName === "getPair") {
        const key = `${(args[0] as string).toLowerCase()}-${(args[1] as string).toLowerCase()}-${Number(args[2])}`;
        return pools[key]?.address ?? "0x0000000000000000000000000000000000000000";
      }
      if (functionName === "liquidity") {
        for (const pool of Object.values(pools)) {
          if (pool.address.toLowerCase() === (address as string).toLowerCase()) {
            return pool.liquidity;
          }
        }
        return 0n;
      }
      return 0n;
    };
    return () => ({
      readContract: async ({ address, functionName, args }: any) =>
        resolvePool(address, functionName, args),
      // discoverBestV3Pool uses multicall for batched factory + liquidity reads
      multicall: async ({ contracts }: { contracts: Array<any> }) =>
        contracts.map(({ address, functionName, args }: any) => ({
          status: "success" as const,
          result: resolvePool(address, functionName, args)
        }))
    });
  }

  it("no direct WETH→USDC pool, finds multi-hop via WMNT — exactInput selector, intent=swap_multihop", async () => {
    const resolveWithWeth = makeResolveToken({
      "weth": { symbol: "WETH", decimals: 18 },
      "usdc": { symbol: "USDC", decimals: 6 },
      [WETH.toLowerCase()]: { symbol: "WETH", decimals: 18 },
      [WMNT.toLowerCase()]: { symbol: "WMNT", decimals: 18 },
      [USDC.toLowerCase()]: { symbol: "USDC", decimals: 6 }
    });
    const result = await buildSwap(
      {
        provider: "agni",
        token_in: "WETH",
        token_out: "USDC",
        amount_in: "1",
        amount_out_min: "3000000000", // 3000 USDC raw
        recipient: FAKE_RECIPIENT
      },
      {
        ...baseDeps,
        resolveTokenInput: resolveWithWeth,
        getClient: makeMultihopClient() as any
      }
    );
    expect(result.intent).toBe("swap_multihop");
    expect(result.unsigned_tx.to).toBe(AGNI_ROUTER);
    expect(result.unsigned_tx.data.startsWith(SELECTOR_EXACT_INPUT)).toBe(true);
    // Multi-hop warning should be present
    expect(result.warnings.some(w => w.includes("Multi-hop"))).toBe(true);
  });
});

// =========================================================================
// Merchant Moe — explicit bin_step
// =========================================================================
describe("buildSwap — merchant_moe, explicit bin_step", () => {
  function makeMoeClient(pairExists: boolean) {
    return () => ({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "getLBPairInformation") {
          return {
            binStep: 25,
            LBPair: pairExists ? FAKE_POOL : "0x0000000000000000000000000000000000000000",
            createdByOwner: false,
            ignoredForRouting: false
          };
        }
        return 0n;
      }
    });
  }

  it("to=LB Router, intent=swap, pool_params.bin_step=25", async () => {
    const result = await buildSwap(
      {
        provider: "merchant_moe",
        token_in: "WMNT",
        token_out: "USDC",
        amount_in: "10",
        amount_out_min: "8000000",
        bin_step: 25,
        recipient: FAKE_RECIPIENT
      },
      { ...baseDeps, getClient: makeMoeClient(true) as any }
    );
    expect(result.unsigned_tx.to).toBe(LB_ROUTER);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.chainId).toBe(5000);
    expect(result.intent).toBe("swap");
    expect(result.pool_params?.provider).toBe("merchant_moe");
    expect(result.pool_params?.bin_step).toBe(25);
    expect(result.pool_params?.router_address).toBe(LB_ROUTER);
  });

  it("LBPair returned from factory → router_version=3 (V2.2)", async () => {
    const result = await buildSwap(
      {
        provider: "merchant_moe",
        token_in: "WMNT",
        token_out: "USDC",
        amount_in: "10",
        amount_out_min: "8000000",
        bin_step: 25,
        recipient: FAKE_RECIPIENT
      },
      { ...baseDeps, getClient: makeMoeClient(true) as any }
    );
    expect(result.pool_params?.router_version).toBe(3);
  });

  it("factory call fails → router_version=0 (V1 fallback)", async () => {
    const failClient = () => ({
      readContract: async () => { throw new Error("RPC timeout"); }
    });
    const result = await buildSwap(
      {
        provider: "merchant_moe",
        token_in: "WMNT",
        token_out: "USDC",
        amount_in: "10",
        amount_out_min: "8000000",
        bin_step: 25,
        recipient: FAKE_RECIPIENT
      },
      { ...baseDeps, getClient: failClient as any }
    );
    expect(result.pool_params?.router_version).toBe(0);
  });
});

// =========================================================================
// Merchant Moe — LB Quoter auto-discovery (no bin_step)
// =========================================================================
describe("buildSwap — merchant_moe, quoter discovery", () => {
  function makeQuoterClient() {
    return () => ({
      readContract: async ({ address, functionName, args }: any) => {
        if (address.toLowerCase() === LB_QUOTER.toLowerCase() && functionName === "findBestPathFromAmountIn") {
          const path = (args as any[])[0];
          // Only respond for 2-token direct path
          if (path.length === 2) {
            return {
              route: path,
              pairs: [FAKE_POOL],
              binSteps: [25n],
              versions: [3n],
              amounts: [10_000000000000000000n, 8_000000n], // amountOut ~ 8 USDC
              virtualAmountsWithoutSlippage: [],
              fees: []
            };
          }
          return null;
        }
        return 0n;
      }
    });
  }

  it("quoter finds direct route — to=LB Router, pool_params.bin_step=25", async () => {
    const result = await buildSwap(
      {
        provider: "merchant_moe",
        token_in: "WMNT",
        token_out: "USDC",
        amount_in: "10",
        amount_out_min: "8000000",
        // no bin_step — auto-discover via quoter
        recipient: FAKE_RECIPIENT
      },
      { ...baseDeps, getClient: makeQuoterClient() as any }
    );
    expect(result.unsigned_tx.to).toBe(LB_ROUTER);
    expect(result.pool_params?.bin_step).toBe(25);
  });

  it("quoter returns null for all paths → NO_ROUTE_FOUND", async () => {
    const noRouteClient = () => ({
      readContract: async () => null
    });
    await expect(
      buildSwap(
        {
          provider: "merchant_moe",
          token_in: "WMNT",
          token_out: "USDC",
          amount_in: "10",
          amount_out_min: "8000000",
          recipient: FAKE_RECIPIENT
        },
        { ...baseDeps, getClient: noRouteClient as any }
      )
    ).rejects.toMatchObject({ code: "NO_ROUTE_FOUND" });
  });
});

// =========================================================================
// Allowance pre-check (blocking, with owner provided)
// =========================================================================
describe("buildSwap — allowance pre-check", () => {
  function makeAllowanceClient(allowance: bigint) {
    return () => ({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "allowance") return allowance;
        // For pool discovery (no fee_tier): return a fake pool with liquidity
        if (functionName === "getPool" || functionName === "getPair") return FAKE_POOL;
        if (functionName === "liquidity") return 1_000_000n;
        return 0n;
      }
    });
  }

  it("allowance < amount_in → INSUFFICIENT_ALLOWANCE (blocks build)", async () => {
    const amountInRaw = 10n * 10n ** 18n; // 10 WMNT
    await expect(
      buildSwap(
        {
          provider: "agni",
          token_in: "WMNT",
          token_out: "USDC",
          amount_in: "10",
          amount_out_min: "8000000",
          fee_tier: 3000,
          recipient: FAKE_RECIPIENT,
          owner: FAKE_WALLET
        },
        { ...baseDeps, getClient: makeAllowanceClient(5n * 10n ** 18n) as any }
      )
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_ALLOWANCE",
      details: expect.objectContaining({
        token: "WMNT",
        required: "10",
        owner: FAKE_WALLET
      })
    });
  });

  it("allowance >= amount_in → proceeds to build calldata", async () => {
    const result = await buildSwap(
      {
        provider: "agni",
        token_in: "WMNT",
        token_out: "USDC",
        amount_in: "10",
        amount_out_min: "8000000",
        fee_tier: 3000,
        recipient: FAKE_RECIPIENT,
        owner: FAKE_WALLET
      },
      { ...baseDeps, getClient: makeAllowanceClient(20n * 10n ** 18n) as any }
    );
    expect(result.intent).toBe("swap");
  });

  it("allowance RPC failure → proceeds without blocking (fail-open)", async () => {
    const failClient = () => ({
      readContract: async () => { throw new Error("RPC timeout"); }
    });
    const result = await buildSwap(
      {
        provider: "agni",
        token_in: "WMNT",
        token_out: "USDC",
        amount_in: "10",
        amount_out_min: "8000000",
        fee_tier: 3000,
        recipient: FAKE_RECIPIENT,
        owner: FAKE_WALLET
      },
      { ...baseDeps, getClient: failClient as any }
    );
    expect(result.intent).toBe("swap");
  });
});

// =========================================================================
// Slippage protection error paths
// =========================================================================
describe("buildSwap — slippage protection errors", () => {
  const baseSwapArgs = {
    provider: "agni",
    token_in: "WMNT",
    token_out: "USDC",
    amount_in: "10",
    fee_tier: 3000,
    recipient: FAKE_RECIPIENT
  };

  it("no amount_out_min and no allow_zero_min → MISSING_SLIPPAGE_PROTECTION", async () => {
    await expect(
      buildSwap(baseSwapArgs, { ...baseDeps, getClient: noRpcClient as any })
    ).rejects.toMatchObject({ code: "MISSING_SLIPPAGE_PROTECTION" });
  });

  it("whitespace-only amount_out_min → INVALID_AMOUNT_FORMAT", async () => {
    await expect(
      buildSwap(
        { ...baseSwapArgs, amount_out_min: "   " },
        { ...baseDeps, getClient: noRpcClient as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT_FORMAT" });
  });

  it("decimal zero amount_out_min ('0.000') → INVALID_AMOUNT_FORMAT", async () => {
    await expect(
      buildSwap(
        { ...baseSwapArgs, amount_out_min: "0.000" },
        { ...baseDeps, getClient: noRpcClient as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT_FORMAT" });
  });

  it("allow_zero_min=true → builds with amountOutMinimum=0 (with warning)", async () => {
    const result = await buildSwap(
      { ...baseSwapArgs, allow_zero_min: true },
      { ...baseDeps, getClient: noRpcClient as any }
    );
    expect(result.intent).toBe("swap");
    expect(result.warnings.some(w => w.includes("slippage"))).toBe(true);
  });

  it("amount_out_min='0' (literal string) with allow_zero_min=true → no error", async () => {
    const result = await buildSwap(
      { ...baseSwapArgs, amount_out_min: "0", allow_zero_min: true },
      { ...baseDeps, getClient: noRpcClient as any }
    );
    expect(result.intent).toBe("swap");
  });
});

// =========================================================================
// Quote cross-validation
// =========================================================================
describe("buildSwap — QUOTE_BUILD_MISMATCH", () => {
  const baseSwapArgs = {
    provider: "agni",
    token_in: "WMNT",
    token_out: "USDC",
    amount_in: "10",
    amount_out_min: "8000000",
    fee_tier: 3000,
    recipient: FAKE_RECIPIENT
  };

  it("quote_fee_tier != resolved fee_tier → QUOTE_BUILD_MISMATCH", async () => {
    await expect(
      buildSwap(
        { ...baseSwapArgs, quote_fee_tier: 500 }, // quote was 500, build resolved 3000
        { ...baseDeps, getClient: noRpcClient as any }
      )
    ).rejects.toMatchObject({ code: "QUOTE_BUILD_MISMATCH" });
  });

  it("quote_provider != provider → QUOTE_BUILD_MISMATCH", async () => {
    await expect(
      buildSwap(
        { ...baseSwapArgs, quote_provider: "merchant_moe" }, // quote was moe, building agni
        { ...baseDeps, getClient: noRpcClient as any }
      )
    ).rejects.toMatchObject({ code: "QUOTE_BUILD_MISMATCH" });
  });

  it("quote_fee_tier == fee_tier and quote_provider == provider → no mismatch", async () => {
    const result = await buildSwap(
      { ...baseSwapArgs, quote_fee_tier: 3000, quote_provider: "agni" },
      { ...baseDeps, getClient: noRpcClient as any }
    );
    expect(result.intent).toBe("swap");
  });
});

// =========================================================================
// xStocks routing guard
// =========================================================================
describe("buildSwap — xStocks", () => {
  it("xStocks token (WMETAX) with non-fluxion provider → XSTOCKS_FLUXION_ONLY", async () => {
    const resolveWithXStock = makeResolveToken({
      "wmetax": { symbol: "WMETAX", decimals: 18 },
      "0xfakeXStock": { symbol: "WMETAX", decimals: 18 }
    });
    await expect(
      buildSwap(
        {
          provider: "agni",
          token_in: "WMETAX",
          token_out: "USDC",
          amount_in: "10",
          amount_out_min: "8000000",
          fee_tier: 3000,
          recipient: FAKE_RECIPIENT
        },
        {
          ...baseDeps,
          resolveTokenInput: async (input: string) => {
            const lower = input.toLowerCase();
            if (lower === "wmetax") return { address: "0x4E41a262cAA93C6575d336E0a4eb79f3c67caa06", symbol: "WMETAX", decimals: 18 };
            if (lower === "usdc") return { address: USDC, symbol: "USDC", decimals: 6 };
            throw new Error(`unknown: ${input}`);
          },
          getClient: noRpcClient as any
        }
      )
    ).rejects.toMatchObject({ code: "XSTOCKS_FLUXION_ONLY" });
  });

  it("xStocks token (WMETAX) with fluxion provider → proceeds (no XSTOCKS_FLUXION_ONLY)", async () => {
    // Should not throw XSTOCKS_FLUXION_ONLY — may fail later (no pool) but not for that reason
    let thrownCode: string | undefined;
    try {
      await buildSwap(
        {
          provider: "fluxion",
          token_in: "WMETAX",
          token_out: "USDC",
          amount_in: "10",
          amount_out_min: "8000000",
          fee_tier: 3000,
          recipient: FAKE_RECIPIENT
        },
        {
          ...baseDeps,
          resolveTokenInput: async (input: string) => {
            const lower = input.toLowerCase();
            if (lower === "wmetax") return { address: "0x4E41a262cAA93C6575d336E0a4eb79f3c67caa06", symbol: "WMETAX", decimals: 18 };
            if (lower === "usdc") return { address: USDC, symbol: "USDC", decimals: 6 };
            throw new Error(`unknown: ${input}`);
          },
          getClient: noRpcClient as any
        }
      );
    } catch (e: any) {
      thrownCode = e?.code;
    }
    expect(thrownCode).not.toBe("XSTOCKS_FLUXION_ONLY");
  });
});

// =========================================================================
// Sepolia warning
// =========================================================================
describe("buildSwap — sepolia", () => {
  it("sepolia network — chainId=5003 and testnet warning in result", async () => {
    const result = await buildSwap(
      {
        provider: "agni",
        token_in: "WMNT",
        token_out: "USDC",
        amount_in: "10",
        amount_out_min: "8000000",
        fee_tier: 3000,
        recipient: FAKE_RECIPIENT,
        network: "sepolia"
      },
      {
        ...baseDeps,
        resolveTokenInput: async (input: string) => {
          const lower = input.toLowerCase();
          if (lower === "wmnt") return { address: "0x19f5557E23e9914A18239990f6C70D68FDF0deD5", symbol: "WMNT", decimals: 18 };
          // Sepolia only has WMNT on the whitelist; use WMNT address for the
          // second token so the whitelist check passes. The test only validates
          // chainId=5003 and the TESTNET warning, not the token composition.
          if (lower === "usdc") return { address: "0x19f5557E23e9914A18239990f6C70D68FDF0deD5", symbol: "USDC", decimals: 6 };
          throw new Error(`unknown: ${input}`);
        },
        getClient: noRpcClient as any
      }
    );
    expect(result.unsigned_tx.chainId).toBe(5003);
    expect(result.warnings.some(w => w.includes("TESTNET") || w.includes("5003"))).toBe(true);
  });
});
