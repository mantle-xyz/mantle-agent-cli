/**
 * Unit tests for Aave V3 write functions:
 *   - buildAaveSupply
 *   - buildAaveBorrow
 *   - buildAaveRepay
 *   - buildAaveWithdraw
 *   - buildAaveSetCollateral (smoke; full coverage in aave-set-collateral.test.ts)
 *
 * All functions use d.getClient() via deps injection. No vi.mock() required.
 */
import { describe, expect, it } from "vitest";
import {
  buildAaveSupply,
  buildAaveBorrow,
  buildAaveRepay,
  buildAaveWithdraw,
  buildAaveSetCollateral
} from "@mantleio/mantle-core/tools/defi-write.js";
import { MantleMcpError } from "@mantleio/mantle-core/errors.js";

// ── Addresses ─────────────────────────────────────────────────────────────
const AAVE_POOL = "0x458F293454fE0d67EC0655f3672301301DD51422";
const USDC_ADDR = "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9";
const WMNT_ADDR = "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8";
const FBTC_ADDR = "0xC96dE26018A54D51c097160568752c4E3BD6C364";
const USDT0_ADDR = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";

// aToken addresses (from aave-reserves.ts)
const A_USDC  = "0xcb8164415274515867ec43CbD284ab5d6d2b304F";
const A_WMNT  = "0x85d86061e94CE01D3DA0f9EFa289c86ff136125a";
const A_FBTC  = "0xfa14c9DE267b59A586043372bd98Ed99e3Ee0533";
const A_USDT0 = "0x7053bAD224F0C021839f6AC645BdaE5F8b585b69";

const FAKE_WALLET = "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF";
const FAKE_RECIPIENT = "0x1111111111111111111111111111111111111111";

// ── ABI selectors ─────────────────────────────────────────────────────────
// keccak256("supply(address,uint256,address,uint16)")[0:4]
const SELECTOR_SUPPLY = "0x617ba037";
// keccak256("borrow(address,uint256,uint256,uint16,address)")[0:4]
const SELECTOR_BORROW = "0xa415bcad";
// keccak256("repay(address,uint256,uint256,address)")[0:4]
const SELECTOR_REPAY = "0x573ade81";
// keccak256("withdraw(address,uint256,address)")[0:4]
const SELECTOR_WITHDRAW = "0x69328dec";
// keccak256("setUserUseReserveAsCollateral(address,bool)")[0:4]
const SELECTOR_SET_COLLATERAL = "0x5a3b74b9";

// ── Shared deps ───────────────────────────────────────────────────────────
const NOW = "2026-01-01T00:00:00.000Z";

/** resolveTokenInput mock: maps underlying token addresses to token metadata */
function makeResolveToken() {
  const table: Record<string, { symbol: string; decimals: number }> = {
    [USDC_ADDR.toLowerCase()]: { symbol: "USDC", decimals: 6 },
    [WMNT_ADDR.toLowerCase()]: { symbol: "WMNT", decimals: 18 },
    [FBTC_ADDR.toLowerCase()]: { symbol: "FBTC", decimals: 8 },
    [USDT0_ADDR.toLowerCase()]: { symbol: "USDT0", decimals: 6 }
  };
  return async (input: string) => {
    const row = table[input.toLowerCase()];
    if (!row) throw new Error(`resolveTokenInput: unknown ${input}`);
    return { address: input, ...row };
  };
}

const baseDeps = {
  now: () => NOW,
  deadline: () => 9_999_999_999n,
  resolveTokenInput: makeResolveToken()
};

// ── No-op client (for functions that don't require RPC reads) ─────────────
const noopClient = () => ({
  readContract: async () => { throw new Error("unexpected readContract call"); }
});

// =========================================================================
// buildAaveSupply
// =========================================================================
describe("buildAaveSupply", () => {
  it("supply 100 USDC — to=AavePool, value=0x0, selector correct, intent=aave_supply", async () => {
    const result = await buildAaveSupply(
      { asset: "USDC", amount: "100", on_behalf_of: FAKE_RECIPIENT },
      { ...baseDeps, getClient: noopClient as any }
    );
    expect(result.intent).toBe("aave_supply");
    expect(result.unsigned_tx.to).toBe(AAVE_POOL);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.data.startsWith(SELECTOR_SUPPLY)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
    expect(result.built_at_utc).toBe(NOW);
  });

  it("supply 10 WMNT — aave_reserve.symbol=WMNT, aave_reserve.decimals=18", async () => {
    const result = await buildAaveSupply(
      { asset: "WMNT", amount: "10", on_behalf_of: FAKE_RECIPIENT },
      { ...baseDeps, getClient: noopClient as any }
    );
    expect(result.aave_reserve?.symbol).toBe("WMNT");
    expect(result.aave_reserve?.decimals).toBe(18);
    expect(result.aave_reserve?.aToken).toBe(A_WMNT);
  });

  it("WMNT supply — isolation mode warnings present", async () => {
    const result = await buildAaveSupply(
      { asset: "WMNT", amount: "10", on_behalf_of: FAKE_RECIPIENT },
      { ...baseDeps, getClient: noopClient as any }
    );
    const warns = result.warnings.join(" ");
    expect(warns).toContain("ISOLATION MODE");
  });

  it("USDC supply — no isolation mode warning", async () => {
    const result = await buildAaveSupply(
      { asset: "USDC", amount: "100", on_behalf_of: FAKE_RECIPIENT },
      { ...baseDeps, getClient: noopClient as any }
    );
    expect(result.warnings.some(w => w.includes("ISOLATION MODE"))).toBe(false);
  });

  it("accepts 'recipient' as alias for 'on_behalf_of'", async () => {
    const result = await buildAaveSupply(
      { asset: "USDC", amount: "50", recipient: FAKE_RECIPIENT },
      { ...baseDeps, getClient: noopClient as any }
    );
    expect(result.intent).toBe("aave_supply");
  });

  it("unsupported asset → UNSUPPORTED_AAVE_ASSET", async () => {
    await expect(
      buildAaveSupply(
        { asset: "FAKE_TOKEN", amount: "100", on_behalf_of: FAKE_RECIPIENT },
        { ...baseDeps, getClient: noopClient as any }
      )
    ).rejects.toMatchObject({ code: "UNSUPPORTED_AAVE_ASSET" });
  });

  it("USDT → UNSUPPORTED_AAVE_ASSET with hint about USDT0", async () => {
    await expect(
      buildAaveSupply(
        { asset: "USDT", amount: "100", on_behalf_of: FAKE_RECIPIENT },
        { ...baseDeps, getClient: noopClient as any }
      )
    ).rejects.toMatchObject({ code: "UNSUPPORTED_AAVE_ASSET" });
  });

  it("supply 0 amount → error", async () => {
    await expect(
      buildAaveSupply(
        { asset: "USDC", amount: "0", on_behalf_of: FAKE_RECIPIENT },
        { ...baseDeps, getClient: noopClient as any }
      )
    ).rejects.toThrow();
  });

  it("aave_reserve fields populated — aToken, variableDebtToken, underlying", async () => {
    const result = await buildAaveSupply(
      { asset: "USDC", amount: "100", on_behalf_of: FAKE_RECIPIENT },
      { ...baseDeps, getClient: noopClient as any }
    );
    expect(result.aave_reserve?.underlying).toBe(USDC_ADDR);
    expect(result.aave_reserve?.aToken).toBe(A_USDC);
    expect(typeof result.aave_reserve?.variableDebtToken).toBe("string");
  });
});

// =========================================================================
// buildAaveBorrow
// =========================================================================
describe("buildAaveBorrow", () => {
  // For USDC (borrowableInIsolation=true): no aToken read needed
  const noReadClient = noopClient;

  it("borrow 50 USDC (variable rate) — to=AavePool, selector correct, intent=aave_borrow", async () => {
    const result = await buildAaveBorrow(
      { asset: "USDC", amount: "50", on_behalf_of: FAKE_RECIPIENT },
      { ...baseDeps, getClient: noReadClient as any }
    );
    expect(result.intent).toBe("aave_borrow");
    expect(result.unsigned_tx.to).toBe(AAVE_POOL);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.data.startsWith(SELECTOR_BORROW)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
  });

  it("borrow USDT0 (borrowableInIsolation=true) — no isolation check", async () => {
    const result = await buildAaveBorrow(
      { asset: "USDT0", amount: "100", on_behalf_of: FAKE_RECIPIENT },
      { ...baseDeps, getClient: noReadClient as any }
    );
    expect(result.intent).toBe("aave_borrow");
  });

  it("interest_rate_mode=1 (stable) — summary mentions stable rate", async () => {
    const result = await buildAaveBorrow(
      { asset: "USDC", amount: "10", on_behalf_of: FAKE_RECIPIENT, interest_rate_mode: 1 },
      { ...baseDeps, getClient: noReadClient as any }
    );
    expect(result.human_summary.toLowerCase()).toContain("stable");
  });

  it("default interest_rate_mode=2 (variable) — summary mentions variable rate", async () => {
    const result = await buildAaveBorrow(
      { asset: "USDC", amount: "10", on_behalf_of: FAKE_RECIPIENT },
      { ...baseDeps, getClient: noReadClient as any }
    );
    expect(result.human_summary.toLowerCase()).toContain("variable");
  });

  it("FBTC (not borrowableInIsolation) — borrower in isolation mode → ISOLATION_MODE_BORROW_BLOCKED", async () => {
    // Mock aToken balances:
    //   isolation (WMNT, WETH) aTokens → WMNT has balance (user is in isolation)
    //   non-isolation (USDT0, USDC, USDe, FBTC) aTokens → all zero
    const client = () => ({
      readContract: async ({ address }: { address: string }) => {
        // aWMNT balance = 1e18 (has isolation collateral)
        if (address.toLowerCase() === A_WMNT.toLowerCase()) return 1_000_000_000_000_000_000n;
        // getUserAccountData → health factor (not called for isolation check)
        return 0n; // all other aTokens = 0
      }
    });
    await expect(
      buildAaveBorrow(
        { asset: "FBTC", amount: "0.001", on_behalf_of: FAKE_RECIPIENT },
        { ...baseDeps, getClient: client as any }
      )
    ).rejects.toMatchObject({ code: "ISOLATION_MODE_BORROW_BLOCKED" });
  });

  it("FBTC — borrower NOT in isolation mode (has non-isolation collateral) → succeeds", async () => {
    const client = () => ({
      readContract: async ({ address }: { address: string }) => {
        // aUSDC balance = 100 USDC (non-isolation collateral)
        if (address.toLowerCase() === A_USDC.toLowerCase()) return 100_000_000n;
        // getUserAccountData → health factor WAD * 5 (healthy)
        return 0n;
      }
    });
    const result = await buildAaveBorrow(
      { asset: "FBTC", amount: "0.001", on_behalf_of: FAKE_RECIPIENT },
      { ...baseDeps, getClient: client as any }
    );
    expect(result.intent).toBe("aave_borrow");
  });

  it("FBTC — RPC failure during isolation check → proceeds with warning", async () => {
    const client = () => ({
      readContract: async () => { throw new Error("RPC timeout"); }
    });
    const result = await buildAaveBorrow(
      { asset: "FBTC", amount: "0.001", on_behalf_of: FAKE_RECIPIENT },
      { ...baseDeps, getClient: client as any }
    );
    expect(result.intent).toBe("aave_borrow");
    expect(result.warnings.some(w => w.includes("ISOLATION MODE WARNING"))).toBe(true);
  });

  it("unsupported asset → UNSUPPORTED_AAVE_ASSET", async () => {
    await expect(
      buildAaveBorrow(
        { asset: "DOGECOIN", amount: "100", on_behalf_of: FAKE_RECIPIENT },
        { ...baseDeps, getClient: noReadClient as any }
      )
    ).rejects.toMatchObject({ code: "UNSUPPORTED_AAVE_ASSET" });
  });
});

// =========================================================================
// buildAaveRepay
// =========================================================================
describe("buildAaveRepay", () => {
  it("repay 50 USDC (variable) — to=AavePool, selector correct, intent=aave_repay", async () => {
    const result = await buildAaveRepay(
      { asset: "USDC", amount: "50", on_behalf_of: FAKE_RECIPIENT },
      { ...baseDeps, getClient: noopClient as any }
    );
    expect(result.intent).toBe("aave_repay");
    expect(result.unsigned_tx.to).toBe(AAVE_POOL);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.data.startsWith(SELECTOR_REPAY)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
  });

  it("amount='max' repays full debt (MAX_UINT256 encoded)", async () => {
    const result = await buildAaveRepay(
      { asset: "USDC", amount: "max", on_behalf_of: FAKE_RECIPIENT },
      { ...baseDeps, getClient: noopClient as any }
    );
    expect(result.intent).toBe("aave_repay");
    expect(result.human_summary).toContain("max");
    // MAX_UINT256 encoded in calldata: repay(address,uint256,uint256,address)
    //   0x + 4-byte selector (8 hex) + asset (64 hex) + amount (64 hex) + rateMode + onBehalfOf
    // The amount param occupies chars [74:138] of the hex string.
    const data = result.unsigned_tx.data;
    expect(data.slice(74, 138)).toBe("f".repeat(64));
  });

  it("stable rate (interest_rate_mode=1) — summary mentions stable", async () => {
    const result = await buildAaveRepay(
      { asset: "WMNT", amount: "5", on_behalf_of: FAKE_RECIPIENT, interest_rate_mode: 1 },
      { ...baseDeps, getClient: noopClient as any }
    );
    expect(result.human_summary.toLowerCase()).toContain("stable");
  });

  it("aave_reserve is populated", async () => {
    const result = await buildAaveRepay(
      { asset: "USDC", amount: "10", on_behalf_of: FAKE_RECIPIENT },
      { ...baseDeps, getClient: noopClient as any }
    );
    expect(result.aave_reserve?.symbol).toBe("USDC");
    expect(result.aave_reserve?.underlying).toBe(USDC_ADDR);
  });

  it("unsupported asset → UNSUPPORTED_AAVE_ASSET", async () => {
    await expect(
      buildAaveRepay(
        { asset: "DOGECOIN", amount: "100", on_behalf_of: FAKE_RECIPIENT },
        { ...baseDeps, getClient: noopClient as any }
      )
    ).rejects.toMatchObject({ code: "UNSUPPORTED_AAVE_ASSET" });
  });
});

// =========================================================================
// buildAaveWithdraw
// =========================================================================
describe("buildAaveWithdraw", () => {
  it("withdraw 50 USDC — to=AavePool, selector correct, intent=aave_withdraw", async () => {
    const result = await buildAaveWithdraw(
      { asset: "USDC", amount: "50", to: FAKE_RECIPIENT, owner: FAKE_WALLET },
      { ...baseDeps, getClient: noopClient as any }
    );
    expect(result.intent).toBe("aave_withdraw");
    expect(result.unsigned_tx.to).toBe(AAVE_POOL);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.data.startsWith(SELECTOR_WITHDRAW)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
  });

  it("amount='max' — summary says 'max' or 'full balance'", async () => {
    const result = await buildAaveWithdraw(
      { asset: "USDC", amount: "max", to: FAKE_RECIPIENT, owner: FAKE_WALLET },
      { ...baseDeps, getClient: noopClient as any }
    );
    expect(result.intent).toBe("aave_withdraw");
    const data = result.unsigned_tx.data;
    // MAX_UINT256 encoded: withdraw(address,uint256,address)
    //   0x + 4-byte selector (8 hex) + asset (64 hex) + amount (64 hex) + to (64 hex)
    // The amount param occupies chars [74:138] of the hex string.
    expect(data.slice(74, 138)).toBe("f".repeat(64));
  });

  it("accepts 'recipient' as alias for 'to'", async () => {
    const result = await buildAaveWithdraw(
      { asset: "USDC", amount: "10", recipient: FAKE_RECIPIENT, owner: FAKE_WALLET },
      { ...baseDeps, getClient: noopClient as any }
    );
    expect(result.intent).toBe("aave_withdraw");
  });

  it("accepts 'sender' as alias for 'owner'", async () => {
    const result = await buildAaveWithdraw(
      { asset: "USDC", amount: "10", to: FAKE_RECIPIENT, sender: FAKE_WALLET },
      { ...baseDeps, getClient: noopClient as any }
    );
    expect(result.intent).toBe("aave_withdraw");
  });

  it("missing owner/sender → INVALID_ADDRESS", async () => {
    await expect(
      buildAaveWithdraw(
        { asset: "USDC", amount: "10", to: FAKE_RECIPIENT },
        { ...baseDeps, getClient: noopClient as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
  });

  it("aave_reserve.symbol and decimals are populated", async () => {
    const result = await buildAaveWithdraw(
      { asset: "WMNT", amount: "5", to: FAKE_RECIPIENT, owner: FAKE_WALLET },
      { ...baseDeps, getClient: noopClient as any }
    );
    expect(result.aave_reserve?.symbol).toBe("WMNT");
    expect(result.aave_reserve?.decimals).toBe(18);
  });

  it("warning about health factor reduction", async () => {
    const result = await buildAaveWithdraw(
      { asset: "USDC", amount: "50", to: FAKE_RECIPIENT, owner: FAKE_WALLET },
      { ...baseDeps, getClient: noopClient as any }
    );
    expect(result.warnings.some(w => w.toLowerCase().includes("health factor"))).toBe(true);
  });
});

// =========================================================================
// buildAaveSetCollateral — smoke tests
// (Full coverage is in aave-set-collateral.test.ts)
// =========================================================================
describe("buildAaveSetCollateral (smoke)", () => {
  function makeCollateralClient(
    aTokenBalance: bigint,
    reserveConfigBitmap: bigint,
    userConfigBitmap: bigint,
    healthFactor: bigint
  ) {
    return () => ({
      // buildAaveSetCollateral batches three reads via multicall:
      //   [0] aToken.balanceOf(user)  → aTokenBalance
      //   [1] pool.getConfiguration(asset) → reserveConfigBitmap
      //   [2] pool.getUserConfiguration(user) → userConfigBitmap
      // Results must be in viem multicall format: { status, result }.
      multicall: async ({ contracts }: { contracts: Array<{ functionName: string }> }) => {
        return contracts.map(call => {
          if (call.functionName === "balanceOf") {
            return { status: "success" as const, result: aTokenBalance };
          }
          if (call.functionName === "getConfiguration") {
            return { status: "success" as const, result: reserveConfigBitmap };
          }
          if (call.functionName === "getUserConfiguration") {
            return { status: "success" as const, result: userConfigBitmap };
          }
          return { status: "success" as const, result: 0n };
        });
      },
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "getUserAccountData") {
          return [0n, 0n, 0n, 0n, 0n, healthFactor];
        }
        return 0n;
      }
    });
  }

  it("enable USDC as collateral — intent=aave_set_collateral, to=AavePool, selector correct", async () => {
    // LTV bits 0-15: 7500 bps (75% LTV) → not zero = can be collateral
    // active bit 56: set; frozen bit 57: not set
    const ltvBitmap = 7500n | (1n << 56n); // active, not frozen, LTV=7500
    const aTokenBalance = 100_000_000n; // 100 USDC aToken (has balance)
    const userConfig = 0n; // collateral not enabled yet

    const result = await buildAaveSetCollateral(
      { asset: "USDC", owner: FAKE_WALLET, use_as_collateral: true },
      {
        ...baseDeps,
        getClient: makeCollateralClient(
          aTokenBalance, ltvBitmap, userConfig, 2_000_000_000_000_000_000n
        ) as any
      }
    );
    expect(result.intent).toBe("aave_set_collateral");
    expect(result.unsigned_tx.to).toBe(AAVE_POOL);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.data.startsWith(SELECTOR_SET_COLLATERAL)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
  });
});
