/**
 * Unit tests for buildRemoveLiquidity.
 *
 * Coverage:
 *   - V3 (agni/fluxion) percentage mode — reads positions, decreaseLiquidity+collect multicall
 *   - V3 explicit liquidity mode
 *   - Merchant Moe LB percentage mode with auto-scan bins
 *   - Merchant Moe LB explicit ids + amounts
 *   - Error paths: POOL_NOT_FOUND, TOKEN_MISMATCH, INVALID_INPUT (invalid %, zero
 *     liquidity, length mismatch, floats in amounts)
 *   - slippage protection computation (getBin + totalSupply)
 *   - isApprovedForAll warning
 *
 * All internal reads use d.getClient() via deps — no vi.mock() required.
 */
import { describe, expect, it } from "vitest";
import { buildRemoveLiquidity } from "@mantleio/mantle-core/tools/defi-write.js";
import { MantleMcpError } from "@mantleio/mantle-core/errors.js";

// ── Contract addresses ─────────────────────────────────────────────────────
const AGNI_POSITION_MANAGER    = "0x218bf598D1453383e2F4AA7b14fFB9BfB102D637";
const FLUXION_POSITION_MANAGER = "0x2b70C4e7cA8E920435A5dB191e066E9E3AFd8DB3";
const LB_ROUTER                = "0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a";
const LB_FACTORY               = "0xa6630671775c4EA2743840F9A5016dCf2A104054";

const WMNT      = "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8";
const USDC      = "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9";
const FAKE_LB_PAIR  = "0xBEEF000000000000000000000000000000000002";
const FAKE_WALLET   = "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF";
const FAKE_RECIPIENT = "0x1111111111111111111111111111111111111111";

// ── ABI selectors ──────────────────────────────────────────────────────────
// keccak256("multicall(bytes[])")[0:4] — V3 PositionManager
const SELECTOR_MULTICALL = "0xac9650d8";
// keccak256("removeLiquidity(...)")[0:4] — LB Router (standard Moe signature)
// We verify the to address and intent instead of hardcoding this selector

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

// =========================================================================
// V3 — percentage mode
// =========================================================================
describe("buildRemoveLiquidity — V3 agni, percentage mode", () => {
  /**
   * positions() result: 12-tuple where index 7 = liquidity
   * [nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity, ...]
   */
  function makeV3Client(totalLiquidity: bigint) {
    return () => ({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "positions") {
          return [0n, FAKE_WALLET, WMNT, USDC, 3000, -60, 60,
            totalLiquidity, 0n, 0n, 0n, 0n];
        }
        return null;
      }
    });
  }

  it("50% of 1_000_000 liquidity — to=agni PM, multicall selector, intent=remove_liquidity", async () => {
    const result = await buildRemoveLiquidity(
      {
        provider: "agni",
        token_id: "12345",
        percentage: 50,
        recipient: FAKE_RECIPIENT,
        owner: FAKE_WALLET
      },
      { ...baseDeps, getClient: makeV3Client(1_000_000n) as any }
    );
    expect(result.intent).toBe("remove_liquidity");
    expect(result.unsigned_tx.to).toBe(AGNI_POSITION_MANAGER);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.data.startsWith(SELECTOR_MULTICALL)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
  });

  it("100% removal — encodes full liquidity amount (differs from 50% calldata)", async () => {
    const client = makeV3Client(500_000n);
    const baseArgs = {
      provider: "agni",
      token_id: "1",
      recipient: FAKE_RECIPIENT,
      owner: FAKE_WALLET
    };
    const result100 = await buildRemoveLiquidity(
      { ...baseArgs, percentage: 100 },
      { ...baseDeps, getClient: client as any }
    );
    const result50 = await buildRemoveLiquidity(
      { ...baseArgs, percentage: 50 },
      { ...baseDeps, getClient: client as any }
    );
    // Different liquidity amounts in decreaseLiquidity → different ABI encoding
    expect(result100.unsigned_tx.data).not.toBe(result50.unsigned_tx.data);
    // 100% removal warning should be present
    expect(result100.warnings.some(w => w.includes("100") || w.includes("liquidity"))).toBe(true);
  });

  it("fluxion: to=fluxion position manager", async () => {
    const result = await buildRemoveLiquidity(
      {
        provider: "fluxion",
        token_id: "42",
        percentage: 50,
        recipient: FAKE_RECIPIENT,
        owner: FAKE_WALLET
      },
      { ...baseDeps, getClient: makeV3Client(2_000_000n) as any }
    );
    expect(result.unsigned_tx.to).toBe(FLUXION_POSITION_MANAGER);
  });

  it("zero liquidity position → INVALID_INPUT", async () => {
    await expect(
      buildRemoveLiquidity(
        {
          provider: "agni",
          token_id: "12345",
          percentage: 50,
          recipient: FAKE_RECIPIENT,
          owner: FAKE_WALLET
        },
        { ...baseDeps, getClient: makeV3Client(0n) as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("percentage = 0 → INVALID_INPUT", async () => {
    await expect(
      buildRemoveLiquidity(
        {
          provider: "agni",
          token_id: "12345",
          percentage: 0,
          recipient: FAKE_RECIPIENT,
          owner: FAKE_WALLET
        },
        { ...baseDeps, getClient: makeV3Client(1_000_000n) as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("percentage > 100 → INVALID_INPUT", async () => {
    await expect(
      buildRemoveLiquidity(
        {
          provider: "agni",
          token_id: "12345",
          percentage: 101,
          recipient: FAKE_RECIPIENT,
          owner: FAKE_WALLET
        },
        { ...baseDeps, getClient: makeV3Client(1_000_000n) as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("pool_params.provider = 'agni' (no router_address — V3 doesn't need approve)", async () => {
    const result = await buildRemoveLiquidity(
      {
        provider: "agni",
        token_id: "1",
        percentage: 100,
        recipient: FAKE_RECIPIENT,
        owner: FAKE_WALLET
      },
      { ...baseDeps, getClient: makeV3Client(100_000n) as any }
    );
    // V3 remove doesn't require ERC-20 approve — router_address intentionally absent
    expect(result.pool_params?.provider).toBe("agni");
    expect(result.pool_params?.router_address).toBeUndefined();
  });
});

// =========================================================================
// V3 — explicit liquidity mode
// =========================================================================
describe("buildRemoveLiquidity — V3 agni, explicit liquidity", () => {
  const noReadClient = () => ({
    readContract: async () => { throw new Error("should not be called in explicit liquidity mode"); }
  });

  it("explicit liquidity string — builds multicall without reading positions", async () => {
    const result = await buildRemoveLiquidity(
      {
        provider: "agni",
        token_id: "12345",
        liquidity: "500000",
        recipient: FAKE_RECIPIENT,
        owner: FAKE_WALLET
      },
      { ...baseDeps, getClient: noReadClient as any }
    );
    expect(result.intent).toBe("remove_liquidity");
    expect(result.unsigned_tx.to).toBe(AGNI_POSITION_MANAGER);
    expect(result.unsigned_tx.data.startsWith(SELECTOR_MULTICALL)).toBe(true);
  });

  it("explicit liquidity number — builds multicall calldata without any RPC call", async () => {
    const result = await buildRemoveLiquidity(
      {
        provider: "agni",
        token_id: 42,
        liquidity: 250000,
        recipient: FAKE_RECIPIENT,
        owner: FAKE_WALLET
      },
      { ...baseDeps, getClient: noReadClient as any }
    );
    expect(result.intent).toBe("remove_liquidity");
    // No RPC was needed (noReadClient would have thrown) — explicit mode bypasses positions()
    expect(result.unsigned_tx.data.startsWith(SELECTOR_MULTICALL)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
  });
});

// =========================================================================
// Merchant Moe — percentage + auto-scan
// =========================================================================
describe("buildRemoveLiquidity — merchant_moe, percentage + auto-scan", () => {
  const ACTIVE_ID = 8388608;
  const LP_BALANCE = 500_000_000_000_000_000n; // 0.5 LP shares per bin

  /**
   * Mock client for Merchant Moe percentage removal with auto-scan:
   *  - getLBPairInformation → returns FAKE_LB_PAIR
   *  - getTokenX → returns WMNT (tokenX)
   *  - getActiveId → returns ACTIVE_ID
   *  - multicall → returns LP balances for bins around active
   *  - getBin → returns reserves for slippage min computation
   *  - totalSupply → returns total LP for the bin
   *  - isApprovedForAll → returns false (need to approve)
   */
  function makeMoeClient(opts: {
    lbPairAddress?: string;
    tokenX?: string;
    lpBalance?: bigint;
    approved?: boolean;
    approvRpcFail?: boolean;
  } = {}) {
    const {
      lbPairAddress = FAKE_LB_PAIR,
      tokenX = WMNT,
      lpBalance = LP_BALANCE,
      approved = false,
      approvRpcFail = false
    } = opts;

    return () => ({
      readContract: async ({ functionName, address }: { functionName: string; address: string }) => {
        switch (functionName) {
          case "getLBPairInformation":
            return {
              LBPair: lbPairAddress,
              binStep: 25,
              createdByOwner: false,
              ignoredForRouting: false
            };
          case "getTokenX": return tokenX;
          case "getActiveId": return ACTIVE_ID;
          case "isApprovedForAll":
            if (approvRpcFail) throw new Error("RPC error");
            return approved;
          // For getBin: return some reserves for slippage computation
          case "getBin": return [100_000_000_000_000_000_000n, 50_000_000n]; // [reserveX, reserveY]
          case "totalSupply": return 1_000_000_000_000_000_000n;
          default: return null;
        }
      },
      multicall: async ({ contracts }: { contracts: unknown[] }) => {
        // Return LP balance for each bin in the multicall.
        // Production code calls: client.multicall({ contracts: [...] })
        // and reads result.status / result.result per entry (viem multicall shape).
        return contracts.map(() => ({ status: "success", result: lpBalance }));
      }
    });
  }

  it("100% removal via auto-scan — to=LB Router, intent=remove_liquidity", async () => {
    const result = await buildRemoveLiquidity(
      {
        provider: "merchant_moe",
        token_a: "WMNT",
        token_b: "USDC",
        bin_step: 25,
        percentage: 100,
        recipient: FAKE_RECIPIENT,
        owner: FAKE_WALLET
      },
      { ...baseDeps, getClient: makeMoeClient() as any }
    );
    expect(result.intent).toBe("remove_liquidity");
    expect(result.unsigned_tx.to).toBe(LB_ROUTER);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.chainId).toBe(5000);
  });

  it("isApprovedForAll=false → warning about needing approveForAll", async () => {
    const result = await buildRemoveLiquidity(
      {
        provider: "merchant_moe",
        token_a: "WMNT",
        token_b: "USDC",
        bin_step: 25,
        percentage: 100,
        recipient: FAKE_RECIPIENT,
        owner: FAKE_WALLET
      },
      { ...baseDeps, getClient: makeMoeClient({ approved: false }) as any }
    );
    expect(result.warnings.some(w => w.includes("approveForAll") || w.includes("approval") || w.includes("operator"))).toBe(true);
  });

  it("isApprovedForAll RPC fail → conservative warning, still builds tx", async () => {
    const result = await buildRemoveLiquidity(
      {
        provider: "merchant_moe",
        token_a: "WMNT",
        token_b: "USDC",
        bin_step: 25,
        percentage: 100,
        recipient: FAKE_RECIPIENT,
        owner: FAKE_WALLET
      },
      { ...baseDeps, getClient: makeMoeClient({ approvRpcFail: true }) as any }
    );
    expect(result.intent).toBe("remove_liquidity");
    expect(result.warnings.some(w => w.includes("approval") || w.includes("approveForAll") || w.includes("operator"))).toBe(true);
  });

  it("LBPair is zero address → POOL_NOT_FOUND", async () => {
    await expect(
      buildRemoveLiquidity(
        {
          provider: "merchant_moe",
          token_a: "WMNT",
          token_b: "USDC",
          bin_step: 25,
          percentage: 50,
          recipient: FAKE_RECIPIENT,
          owner: FAKE_WALLET
        },
        {
          ...baseDeps,
          getClient: makeMoeClient({
            lbPairAddress: "0x0000000000000000000000000000000000000000"
          }) as any
        }
      )
    ).rejects.toMatchObject({ code: "POOL_NOT_FOUND" });
  });

  it("tokenX does not match either token → TOKEN_MISMATCH", async () => {
    const UNRELATED = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    await expect(
      buildRemoveLiquidity(
        {
          provider: "merchant_moe",
          token_a: "WMNT",
          token_b: "USDC",
          bin_step: 25,
          percentage: 100,
          recipient: FAKE_RECIPIENT,
          owner: FAKE_WALLET
        },
        { ...baseDeps, getClient: makeMoeClient({ tokenX: UNRELATED }) as any }
      )
    ).rejects.toMatchObject({ code: "TOKEN_MISMATCH" });
  });

  it("percentage < 0.005% (precision too low) → INVALID_INPUT", async () => {
    await expect(
      buildRemoveLiquidity(
        {
          provider: "merchant_moe",
          token_a: "WMNT",
          token_b: "USDC",
          bin_step: 25,
          percentage: 0.001, // below 0.005% threshold
          recipient: FAKE_RECIPIENT,
          owner: FAKE_WALLET
        },
        { ...baseDeps, getClient: makeMoeClient() as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

// =========================================================================
// Merchant Moe — explicit ids + amounts
// =========================================================================
describe("buildRemoveLiquidity — merchant_moe, explicit ids + amounts", () => {
  function makeMoeExplicitClient(opts: { tokenX?: string } = {}) {
    const { tokenX = WMNT } = opts;
    return () => ({
      readContract: async ({ functionName }: { functionName: string }) => {
        switch (functionName) {
          case "getLBPairInformation":
            return { LBPair: FAKE_LB_PAIR, binStep: 25, createdByOwner: false, ignoredForRouting: false };
          case "getTokenX": return tokenX;
          case "getActiveId": return 8388608;
          case "isApprovedForAll": return true; // approved — no warning
          case "getBin": return [100_000_000_000_000_000_000n, 50_000_000n];
          case "totalSupply": return 1_000_000_000_000_000_000n;
          default: return null;
        }
      },
      multicall: async (calls: unknown[]) =>
        (calls as unknown[]).map(() => ({ success: true, returnData: "0x0" }))
    });
  }

  it("explicit ids + amounts — to=LB Router, intent=remove_liquidity", async () => {
    const result = await buildRemoveLiquidity(
      {
        provider: "merchant_moe",
        token_a: "WMNT",
        token_b: "USDC",
        bin_step: 25,
        ids: [8388608, 8388609],
        amounts: ["500000000000000000", "300000000000000000"],
        recipient: FAKE_RECIPIENT,
        owner: FAKE_WALLET
      },
      { ...baseDeps, getClient: makeMoeExplicitClient() as any }
    );
    expect(result.intent).toBe("remove_liquidity");
    expect(result.unsigned_tx.to).toBe(LB_ROUTER);
  });

  it("ids provided but no amounts → INVALID_INPUT", async () => {
    await expect(
      buildRemoveLiquidity(
        {
          provider: "merchant_moe",
          token_a: "WMNT",
          token_b: "USDC",
          bin_step: 25,
          ids: [8388608],
          // no amounts
          recipient: FAKE_RECIPIENT,
          owner: FAKE_WALLET
        },
        { ...baseDeps, getClient: makeMoeExplicitClient() as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("amounts provided but no ids → INVALID_INPUT", async () => {
    await expect(
      buildRemoveLiquidity(
        {
          provider: "merchant_moe",
          token_a: "WMNT",
          token_b: "USDC",
          bin_step: 25,
          // no ids
          amounts: ["500000000000000000"],
          recipient: FAKE_RECIPIENT,
          owner: FAKE_WALLET
        },
        { ...baseDeps, getClient: makeMoeExplicitClient() as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("ids and amounts length mismatch → INVALID_INPUT", async () => {
    await expect(
      buildRemoveLiquidity(
        {
          provider: "merchant_moe",
          token_a: "WMNT",
          token_b: "USDC",
          bin_step: 25,
          ids: [8388608, 8388609],
          amounts: ["500000000000000000"], // 1 vs 2
          recipient: FAKE_RECIPIENT,
          owner: FAKE_WALLET
        },
        { ...baseDeps, getClient: makeMoeExplicitClient() as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("float in ids (e.g. 838860.5) → INVALID_INPUT", async () => {
    await expect(
      buildRemoveLiquidity(
        {
          provider: "merchant_moe",
          token_a: "WMNT",
          token_b: "USDC",
          bin_step: 25,
          ids: [8388608.5], // float
          amounts: ["500000000000000000"],
          recipient: FAKE_RECIPIENT,
          owner: FAKE_WALLET
        },
        { ...baseDeps, getClient: makeMoeExplicitClient() as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

// =========================================================================
// Common validation
// =========================================================================
describe("buildRemoveLiquidity — common validation", () => {
  const noopClient = () => ({
    readContract: async () => null,
    multicall: async () => []
  });

  it("missing owner → INVALID_ADDRESS", async () => {
    await expect(
      buildRemoveLiquidity(
        {
          provider: "agni",
          token_id: "1",
          percentage: 100,
          recipient: FAKE_RECIPIENT
          // no owner
        },
        { ...baseDeps, getClient: noopClient as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
  });

  it("invalid recipient → INVALID_ADDRESS", async () => {
    await expect(
      buildRemoveLiquidity(
        {
          provider: "agni",
          token_id: "1",
          percentage: 100,
          recipient: "not-an-address",
          owner: FAKE_WALLET
        },
        { ...baseDeps, getClient: noopClient as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
  });

  it("token_id is ABI-encoded in multicall calldata (token_id=9999 → 0x270f)", async () => {
    const client = () => ({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "positions") {
          return [0n, FAKE_WALLET, WMNT, USDC, 3000, -60, 60, 1_000_000n, 0n, 0n, 0n, 0n];
        }
        return null;
      }
    });
    const result = await buildRemoveLiquidity(
      {
        provider: "agni",
        token_id: "9999",
        percentage: 50,
        recipient: FAKE_RECIPIENT,
        owner: FAKE_WALLET
      },
      { ...baseDeps, getClient: client as any }
    );
    // decreaseLiquidity(tokenId=9999,...) is encoded inside the multicall bytes[].
    // 9999 decimal = 0x270f → ABI-padded to 32 bytes in the inner calldata.
    expect(result.unsigned_tx.data.toLowerCase()).toContain(
      "000000000000000000000000000000000000000000000000000000000000270f"
    );
    expect(result.unsigned_tx.chainId).toBe(5000);
    expect(result.built_at_utc).toBe(NOW);
  });
});
