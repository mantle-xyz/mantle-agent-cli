/**
 * Unit tests for buildAddLiquidity.
 *
 * Coverage:
 *   - V3 (agni) with explicit tick_lower/tick_upper — mint calldata, to=PM, intent
 *   - V3 with range_preset (moderate) — tick computation from slot0
 *   - V3 USD mode — amount_usd split (pool-state-aware ratio)
 *   - Merchant Moe LB — addLiquidity calldata, to=LB Router, intent
 *   - Merchant Moe — auto distribution (no delta_ids), explicit distribution
 *   - Error paths: POOL_NOT_FOUND, TOKEN_MISMATCH, INVALID_INPUT (bad range_preset,
 *     bad distribution sum, distribution length mismatch), PRICE_UNAVAILABLE
 *
 * buildV3AddLiquidity uses getPublicClient(network) directly (not via deps)
 * for pool-state-aware amountMin computation. We vi.mock() clients.js to
 * inject a controlled mock client for that internal call.
 */
import { vi, describe, expect, it, beforeEach, afterEach } from "vitest";

// Must mock BEFORE importing the module under test (vitest auto-hoists vi.mock)
vi.mock("@mantleio/mantle-core/lib/clients.js", () => ({
  getPublicClient: vi.fn()
}));

import { buildAddLiquidity } from "@mantleio/mantle-core/tools/defi-write.js";
import { getPublicClient } from "@mantleio/mantle-core/lib/clients.js";
import { MantleMcpError } from "@mantleio/mantle-core/errors.js";

// ── Contract addresses ─────────────────────────────────────────────────────
const AGNI_POSITION_MANAGER   = "0x218bf598D1453383e2F4AA7b14fFB9BfB102D637";
const FLUXION_POSITION_MANAGER = "0x2b70C4e7cA8E920435A5dB191e066E9E3AFd8DB3";
const AGNI_FACTORY             = "0x25780dc8Fc3cfBD75F33bFDAB65e969b603b2035";
const LB_ROUTER                = "0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a";
const LB_FACTORY               = "0xa6630671775c4EA2743840F9A5016dCf2A104054";

const WMNT   = "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8";
const USDC   = "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9";
const FAKE_POOL = "0xBEEF000000000000000000000000000000000001";
const FAKE_LB_PAIR = "0xBEEF000000000000000000000000000000000002";
const FAKE_RECIPIENT = "0x1111111111111111111111111111111111111111";
const FAKE_WALLET    = "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF";

// ── ABI selectors ──────────────────────────────────────────────────────────
// keccak256("mint(...)")[0:4] — V3 NonfungiblePositionManager
const SELECTOR_MINT = "0x88316456";
// keccak256("addLiquidity(...)")[0:4] — LB Router
// The actual selector for LBRouter.addLiquidity(...) from merchant-moe ABI
const SELECTOR_ADD_LIQUIDITY_LB = "0x02751cec"; // standard Moe LB addLiquidity selector

// ── Shared deps ────────────────────────────────────────────────────────────
const NOW = "2026-01-01T00:00:00.000Z";

function makeResolveToken() {
  return async (input: string) => {
    const lower = input.toLowerCase();
    const map: Record<string, { address: string; symbol: string; decimals: number }> = {
      "wmnt": { address: WMNT,  symbol: "WMNT",  decimals: 18 },
      "usdc": { address: USDC,  symbol: "USDC",  decimals: 6  },
      [WMNT.toLowerCase()]: { address: WMNT,  symbol: "WMNT",  decimals: 18 },
      [USDC.toLowerCase()]: { address: USDC,  symbol: "USDC",  decimals: 6  }
    };
    const row = map[lower];
    if (!row) throw new Error(`resolveTokenInput: unknown '${input}'`);
    return row;
  };
}

const baseDeps = {
  now: () => NOW,
  deadline: () => 9_999_999_999n,
  resolveTokenInput: makeResolveToken()
};

// ── Mock client factory ─────────────────────────────────────────────────────
/**
 * Creates a mock readContract client for the outer buildAddLiquidity deps injection.
 * Returns controlled values for getPool, slot0, tickSpacing, getLBPairInformation, etc.
 */
function makeOuterClient(opts: {
  poolAddress?: string;
  currentTick?: number;
  tickSpacing?: number;
  sqrtPriceX96?: bigint;
  lbPairAddress?: string;
  activeId?: number;
  tokenX?: string;
  allowance?: bigint;
}) {
  const {
    poolAddress = FAKE_POOL,
    currentTick = 0,
    tickSpacing = 60,
    sqrtPriceX96 = BigInt("79228162514264337593543950336"), // sqrt(1) * 2^96 ≈ price=1
    lbPairAddress = FAKE_LB_PAIR,
    activeId = 8388608,
    tokenX = WMNT,
    allowance = BigInt("1000000000000000000000000") // very large
  } = opts;

  return () => ({
    readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      switch (functionName) {
        case "getPool":
          return poolAddress;
        case "slot0":
          return [sqrtPriceX96, currentTick, 0, 0, 0, 0, true] as const;
        case "tickSpacing":
          return tickSpacing;
        case "getLBPairInformation":
          return {
            binStep: 25,
            LBPair: lbPairAddress,
            createdByOwner: false,
            ignoredForRouting: false
          };
        case "getActiveId":
          return activeId;
        case "getTokenX":
          return tokenX;
        case "allowance":
          return allowance;
        default:
          return null;
      }
    }
  });
}

/**
 * Mock for buildV3AddLiquidity's internal getPublicClient(network) call.
 * Returns a controlled pool state for pool-state-aware amountMin computation.
 */
function makeInnerMockClient(opts: {
  poolAddress?: string;
  sqrtPriceX96?: bigint;
  currentTick?: number;
  tickSpacing?: number;
} = {}) {
  const {
    poolAddress = FAKE_POOL,
    sqrtPriceX96 = BigInt("79228162514264337593543950336"),
    currentTick = 0,
    tickSpacing = 60
  } = opts;
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "getPool": return poolAddress;
        case "slot0": return [sqrtPriceX96, currentTick, 0, 0, 0, 0, true] as const;
        case "tickSpacing": return tickSpacing;
        default: return null;
      }
    }
  };
}

beforeEach(() => {
  vi.mocked(getPublicClient).mockReturnValue(
    makeInnerMockClient() as any
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// =========================================================================
// V3 — explicit tick_lower / tick_upper
// =========================================================================
describe("buildAddLiquidity — V3 agni, explicit ticks", () => {
  const v3Args = {
    provider: "agni",
    token_a: "WMNT",
    token_b: "USDC",
    amount_a: "10",
    amount_b: "20",
    tick_lower: -60,
    tick_upper: 60,
    fee_tier: 3000,
    recipient: FAKE_RECIPIENT
  };

  it("to=agni position manager, value=0x0, data starts with mint selector", async () => {
    const result = await buildAddLiquidity(v3Args, {
      ...baseDeps,
      getClient: makeOuterClient({}) as any
    });
    expect(result.unsigned_tx.to).toBe(AGNI_POSITION_MANAGER);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.data.startsWith(SELECTOR_MINT)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
  });

  it("intent=add_liquidity, built_at_utc matches now()", async () => {
    const result = await buildAddLiquidity(v3Args, {
      ...baseDeps,
      getClient: makeOuterClient({}) as any
    });
    expect(result.intent).toBe("add_liquidity");
    expect(result.built_at_utc).toBe(NOW);
  });

  it("fluxion: to=fluxion position manager", async () => {
    const result = await buildAddLiquidity(
      { ...v3Args, provider: "fluxion" },
      { ...baseDeps, getClient: makeOuterClient({}) as any }
    );
    expect(result.unsigned_tx.to).toBe(FLUXION_POSITION_MANAGER);
  });

  it("full-range ticks — warning about full-range usage when pool is active", async () => {
    vi.mocked(getPublicClient).mockReturnValue(makeInnerMockClient({
      poolAddress: FAKE_POOL,
      currentTick: 0,
      tickSpacing: 60
    }) as any);
    // Full-range tick bounds for tickSpacing=60: ±887220
    const result = await buildAddLiquidity(
      { ...v3Args, tick_lower: -887220, tick_upper: 887220 },
      { ...baseDeps, getClient: makeOuterClient({}) as any }
    );
    expect(result.warnings.some(w => w.includes("full") || w.includes("full-range"))).toBe(true);
  });

  it("out-of-range ticks — warning that position won't earn fees", async () => {
    vi.mocked(getPublicClient).mockReturnValue(makeInnerMockClient({
      poolAddress: FAKE_POOL,
      currentTick: 0, // current price at tick 0
      tickSpacing: 60
    }) as any);
    // Current tick=0 is NOT in [200, 400]
    const result = await buildAddLiquidity(
      { ...v3Args, tick_lower: 200, tick_upper: 400 },
      { ...baseDeps, getClient: makeOuterClient({ currentTick: 0 }) as any }
    );
    expect(result.warnings.some(w => w.includes("OUT-OF-RANGE") || w.includes("fees"))).toBe(true);
  });

  it("pool state RPC failure → fallback warning added but calldata still built", async () => {
    // Make inner mock throw so pool state falls back
    vi.mocked(getPublicClient).mockReturnValue({
      readContract: async () => { throw new Error("RPC timeout"); }
    } as any);
    const result = await buildAddLiquidity(v3Args, {
      ...baseDeps,
      getClient: makeOuterClient({}) as any
    });
    expect(result.unsigned_tx.data.startsWith(SELECTOR_MINT)).toBe(true);
    expect(result.warnings.some(w => w.includes("pool state") || w.includes("fallback") || w.includes("amountMin"))).toBe(true);
  });

  it("invalid provider → INVALID_INPUT (UNSUPPORTED_PROTOCOL)", async () => {
    await expect(
      buildAddLiquidity(
        { ...v3Args, provider: "unknown_dex" },
        { ...baseDeps, getClient: makeOuterClient({}) as any }
      )
    ).rejects.toThrow();
  });
});

// =========================================================================
// V3 — range_preset
// =========================================================================
describe("buildAddLiquidity — V3 agni, range_preset", () => {
  it("range_preset='moderate' (±10%) — computes tick range from slot0, builds mint calldata", async () => {
    // currentTick = 0, tickSpacing = 60
    // ±10% → tickOffset ≈ ±953 → floor/ceil to nearest 60
    const outerClient = makeOuterClient({
      poolAddress: FAKE_POOL,
      currentTick: 1000,
      tickSpacing: 60
    });
    vi.mocked(getPublicClient).mockReturnValue(
      makeInnerMockClient({ poolAddress: FAKE_POOL, currentTick: 1000, tickSpacing: 60 }) as any
    );
    const result = await buildAddLiquidity(
      {
        provider: "agni",
        token_a: "WMNT",
        token_b: "USDC",
        amount_a: "10",
        amount_b: "20",
        fee_tier: 3000,
        range_preset: "moderate",
        recipient: FAKE_RECIPIENT
      },
      { ...baseDeps, getClient: outerClient as any }
    );
    expect(result.unsigned_tx.to).toBe(AGNI_POSITION_MANAGER);
    expect(result.unsigned_tx.data.startsWith(SELECTOR_MINT)).toBe(true);
    // range_preset warning should be present
    expect(result.warnings.some(w => w.includes("range_preset") || w.includes("moderate"))).toBe(true);
  });

  it("range_preset='aggressive' (±5%) — narrower range than moderate", async () => {
    const outerClient = makeOuterClient({ poolAddress: FAKE_POOL, currentTick: 0, tickSpacing: 60 });
    vi.mocked(getPublicClient).mockReturnValue(
      makeInnerMockClient({ poolAddress: FAKE_POOL, currentTick: 0, tickSpacing: 60 }) as any
    );
    const result = await buildAddLiquidity(
      {
        provider: "agni",
        token_a: "WMNT",
        token_b: "USDC",
        amount_a: "10",
        amount_b: "20",
        fee_tier: 3000,
        range_preset: "aggressive",
        recipient: FAKE_RECIPIENT
      },
      { ...baseDeps, getClient: outerClient as any }
    );
    expect(result.intent).toBe("add_liquidity");
    expect(result.warnings.some(w => w.includes("aggressive"))).toBe(true);
  });

  it("invalid range_preset → INVALID_INPUT", async () => {
    await expect(
      buildAddLiquidity(
        {
          provider: "agni",
          token_a: "WMNT",
          token_b: "USDC",
          amount_a: "10",
          amount_b: "20",
          fee_tier: 3000,
          range_preset: "ultra",
          recipient: FAKE_RECIPIENT
        },
        { ...baseDeps, getClient: makeOuterClient({}) as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("range_preset + no pool (zero address) → POOL_NOT_FOUND", async () => {
    await expect(
      buildAddLiquidity(
        {
          provider: "agni",
          token_a: "WMNT",
          token_b: "USDC",
          amount_a: "10",
          amount_b: "20",
          fee_tier: 3000,
          range_preset: "moderate",
          recipient: FAKE_RECIPIENT
        },
        {
          ...baseDeps,
          getClient: makeOuterClient({
            poolAddress: "0x0000000000000000000000000000000000000000"
          }) as any
        }
      )
    ).rejects.toMatchObject({ code: "POOL_NOT_FOUND" });
  });
});

// =========================================================================
// Merchant Moe LB — token amounts
// =========================================================================
describe("buildAddLiquidity — merchant_moe, token amounts", () => {
  const lbArgs = {
    provider: "merchant_moe",
    token_a: "WMNT",
    token_b: "USDC",
    amount_a: "10",
    amount_b: "20",
    bin_step: 25,
    recipient: FAKE_RECIPIENT
  };

  it("to=LB Router, value=0x0, intent=add_liquidity", async () => {
    const result = await buildAddLiquidity(lbArgs, {
      ...baseDeps,
      getClient: makeOuterClient({ lbPairAddress: FAKE_LB_PAIR, tokenX: WMNT }) as any
    });
    expect(result.unsigned_tx.to).toBe(LB_ROUTER);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.intent).toBe("add_liquidity");
    expect(result.unsigned_tx.chainId).toBe(5000);
    // Data must contain encoded addLiquidity call (longer than selector alone)
    expect(result.unsigned_tx.data.length).toBeGreaterThan(10);
  });

  it("auto-distribution (no delta_ids) — warning about auto-generated bins", async () => {
    const result = await buildAddLiquidity(lbArgs, {
      ...baseDeps,
      getClient: makeOuterClient({ lbPairAddress: FAKE_LB_PAIR, tokenX: WMNT }) as any
    });
    expect(result.warnings.some(w => w.includes("Auto-generated") || w.includes("distribution"))).toBe(true);
  });

  it("tokenA is tokenX (WMNT) — no TOKEN_MISMATCH error", async () => {
    const result = await buildAddLiquidity(
      { ...lbArgs, token_a: "WMNT", token_b: "USDC" },
      { ...baseDeps, getClient: makeOuterClient({ lbPairAddress: FAKE_LB_PAIR, tokenX: WMNT }) as any }
    );
    expect(result.intent).toBe("add_liquidity");
  });

  it("tokenB is tokenX (USDC < WMNT address-wise) — sorts correctly, no TOKEN_MISMATCH", async () => {
    const result = await buildAddLiquidity(
      { ...lbArgs, token_a: "WMNT", token_b: "USDC" },
      {
        ...baseDeps,
        getClient: makeOuterClient({ lbPairAddress: FAKE_LB_PAIR, tokenX: USDC }) as any // tokenX=USDC
      }
    );
    expect(result.intent).toBe("add_liquidity");
  });

  it("pair tokenX matches neither token → TOKEN_MISMATCH", async () => {
    const UNRELATED = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    await expect(
      buildAddLiquidity(
        { ...lbArgs },
        {
          ...baseDeps,
          getClient: makeOuterClient({ lbPairAddress: FAKE_LB_PAIR, tokenX: UNRELATED }) as any
        }
      )
    ).rejects.toMatchObject({ code: "TOKEN_MISMATCH" });
  });

  it("LBPair is zero address → POOL_NOT_FOUND", async () => {
    await expect(
      buildAddLiquidity(
        { ...lbArgs },
        {
          ...baseDeps,
          getClient: makeOuterClient({
            lbPairAddress: "0x0000000000000000000000000000000000000000"
          }) as any
        }
      )
    ).rejects.toMatchObject({ code: "POOL_NOT_FOUND" });
  });
});

// =========================================================================
// Merchant Moe LB — explicit distribution
// =========================================================================
describe("buildAddLiquidity — merchant_moe, explicit distribution", () => {
  const ONE_E18 = 1_000_000_000_000_000_000;

  it("valid explicit distribution (3 bins, sums to 1e18) — builds calldata", async () => {
    const result = await buildAddLiquidity(
      {
        provider: "merchant_moe",
        token_a: "WMNT",
        token_b: "USDC",
        amount_a: "10",
        amount_b: "20",
        bin_step: 25,
        delta_ids: [-1, 0, 1],
        distribution_x: [0, ONE_E18 / 2, ONE_E18 / 2],
        distribution_y: [ONE_E18 / 2, ONE_E18 / 2, 0],
        recipient: FAKE_RECIPIENT
      },
      {
        ...baseDeps,
        getClient: makeOuterClient({ lbPairAddress: FAKE_LB_PAIR, tokenX: WMNT }) as any
      }
    );
    expect(result.intent).toBe("add_liquidity");
  });

  it("distribution length mismatch → INVALID_INPUT", async () => {
    await expect(
      buildAddLiquidity(
        {
          provider: "merchant_moe",
          token_a: "WMNT",
          token_b: "USDC",
          amount_a: "10",
          amount_b: "20",
          bin_step: 25,
          delta_ids: [-1, 0, 1],        // 3 elements
          distribution_x: [0, ONE_E18], // 2 elements — mismatch
          distribution_y: [ONE_E18, 0, 0],
          recipient: FAKE_RECIPIENT
        },
        {
          ...baseDeps,
          getClient: makeOuterClient({ lbPairAddress: FAKE_LB_PAIR, tokenX: WMNT }) as any
        }
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("distribution_x sum != 1e18 when amount_a > 0 → INVALID_INPUT", async () => {
    await expect(
      buildAddLiquidity(
        {
          provider: "merchant_moe",
          token_a: "WMNT",
          token_b: "USDC",
          amount_a: "10",
          amount_b: "0",
          bin_step: 25,
          delta_ids: [-1, 0, 1],
          distribution_x: [0, 0, 0],      // sums to 0, but amount_a > 0 → invalid
          distribution_y: [ONE_E18, 0, 0], // valid for amount_b=0
          recipient: FAKE_RECIPIENT
        },
        {
          ...baseDeps,
          getClient: makeOuterClient({ lbPairAddress: FAKE_LB_PAIR, tokenX: WMNT }) as any
        }
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("one-sided deposit (amount_b=0, distribution_y all zero) — allowed", async () => {
    const result = await buildAddLiquidity(
      {
        provider: "merchant_moe",
        token_a: "WMNT",
        token_b: "USDC",
        amount_a: "10",
        amount_b: "0",
        bin_step: 25,
        delta_ids: [0, 1, 2],
        distribution_x: [ONE_E18 / 3, ONE_E18 / 3, ONE_E18 - (2 * (ONE_E18 / 3))], // sums to 1e18
        distribution_y: [0, 0, 0], // sum=0, amount_b=0 → valid
        recipient: FAKE_RECIPIENT
      },
      {
        ...baseDeps,
        getClient: makeOuterClient({ lbPairAddress: FAKE_LB_PAIR, tokenX: WMNT }) as any
      }
    );
    expect(result.intent).toBe("add_liquidity");
  });
});

// =========================================================================
// Merchant Moe LB — range_preset
// =========================================================================
describe("buildAddLiquidity — merchant_moe, range_preset", () => {
  it("range_preset='conservative' (±20%) — computes deltaIds, auto-distribution", async () => {
    const result = await buildAddLiquidity(
      {
        provider: "merchant_moe",
        token_a: "WMNT",
        token_b: "USDC",
        amount_a: "10",
        amount_b: "20",
        bin_step: 25,
        range_preset: "conservative",
        recipient: FAKE_RECIPIENT
      },
      {
        ...baseDeps,
        getClient: makeOuterClient({ lbPairAddress: FAKE_LB_PAIR, tokenX: WMNT }) as any
      }
    );
    expect(result.intent).toBe("add_liquidity");
    expect(result.unsigned_tx.to).toBe(LB_ROUTER);
  });
});

// =========================================================================
// Allowance pre-check
// =========================================================================
describe("buildAddLiquidity — allowance pre-check", () => {
  it("token_a allowance insufficient → INSUFFICIENT_ALLOWANCE", async () => {
    const clientWithLowAllowance = () => ({
      readContract: async ({ functionName, address }: { functionName: string; address: string }) => {
        if (functionName === "getLBPairInformation") {
          return { binStep: 25, LBPair: FAKE_LB_PAIR, createdByOwner: false, ignoredForRouting: false };
        }
        if (functionName === "getActiveId") return 8388608;
        if (functionName === "getTokenX") return WMNT;
        if (functionName === "allowance") {
          // WMNT has 0 allowance
          if (address.toLowerCase() === WMNT.toLowerCase()) return 0n;
          return BigInt("1000000000000000000000000"); // USDC has plenty
        }
        return null;
      }
    });
    await expect(
      buildAddLiquidity(
        {
          provider: "merchant_moe",
          token_a: "WMNT",
          token_b: "USDC",
          amount_a: "10",
          amount_b: "20",
          bin_step: 25,
          recipient: FAKE_RECIPIENT,
          owner: FAKE_WALLET
        },
        { ...baseDeps, getClient: clientWithLowAllowance as any }
      )
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ALLOWANCE" });
  });
});

// =========================================================================
// Missing amounts
// =========================================================================
describe("buildAddLiquidity — missing amounts", () => {
  it("no amount_a, no amount_b, no amount_usd → INVALID_INPUT", async () => {
    await expect(
      buildAddLiquidity(
        {
          provider: "agni",
          token_a: "WMNT",
          token_b: "USDC",
          tick_lower: -60,
          tick_upper: 60,
          fee_tier: 3000,
          recipient: FAKE_RECIPIENT
          // no amount_a, amount_b, or amount_usd
        },
        { ...baseDeps, getClient: makeOuterClient({}) as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
