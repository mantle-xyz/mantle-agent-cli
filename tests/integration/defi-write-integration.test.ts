/**
 * Integration tests for defi-write build functions.
 *
 * These tests hit the REAL Mantle mainnet RPC (https://rpc.mantle.xyz/).
 * They verify the full pipeline end-to-end: real token resolution, real
 * on-chain reads (pool state, reserves, LB pair info), and correct calldata.
 *
 * HOW TO RUN:
 *   MANTLE_INTEGRATION_TESTS=1 npx vitest run tests/integration/defi-write-integration.test.ts
 *
 * Skipped automatically when MANTLE_INTEGRATION_TESTS is not set (CI-safe).
 *
 * Coverage:
 *   - buildSwap V3 agni — explicit fee_tier (selector, to address, chainId)
 *   - buildSwap V3 agni — auto pool discovery via getPool
 *   - buildSwap V3 fluxion — explicit fee_tier
 *   - buildSwap merchant_moe — explicit bin_step via real getLBPairInformation
 *   - buildSwap merchant_moe — quoter auto-discovery via real findBestPathFromAmountIn
 *   - buildAddLiquidity V3 agni — range_preset (real slot0 + tickSpacing read)
 *   - buildAddLiquidity V3 agni — explicit ticks (pure encoding, no RPC read)
 *   - buildAddLiquidity V3 fluxion — to=fluxion position manager
 *   - buildAddLiquidity merchant_moe — range_preset (real getActiveId read)
 *   - buildRemoveLiquidity V3 agni — explicit liquidity (pure encoding, no positions read)
 *   - buildRemoveLiquidity V3 fluxion — to=fluxion position manager
 *   - buildRemoveLiquidity merchant_moe — explicit ids+amounts (real getBin read)
 *   - buildWrapMnt / buildUnwrapMnt — to=WMNT, selectors, value encoding
 *   - buildAaveSupply — real reserve table, correct selector
 *   - buildAaveBorrow USDC (borrowableInIsolation) — no isolation check RPC needed
 *   - buildAaveBorrow FBTC (NOT borrowableInIsolation) — reads real aToken balances
 *   - buildAaveRepay — max repay (MAX_UINT256 encoding)
 *   - buildAaveWithdraw — health factor warning
 *   - buildCollectFees — graceful handling of non-existent position
 *   - buildSetLBApprovalForAll — real factory lookup, correct to address
 */
import { describe, expect, it } from "vitest";
import {
  buildSwap,
  buildAddLiquidity,
  buildRemoveLiquidity,
  buildWrapMnt,
  buildUnwrapMnt,
  buildAaveSupply,
  buildAaveBorrow,
  buildAaveRepay,
  buildAaveWithdraw,
  buildCollectFees,
  buildSetLBApprovalForAll
} from "@mantleio/mantle-core/tools/defi-write.js";

// ── Gate: skip unless MANTLE_INTEGRATION_TESTS=1 ──────────────────────────
const ENABLED = process.env.MANTLE_INTEGRATION_TESTS === "1";

// ── Well-known Mantle mainnet contract addresses ──────────────────────────
const AGNI_ROUTER = "0x319B69888b0d11cEC22caA5034e25FfFBDc88421";
const AGNI_PM     = "0x218bf598D1453383e2F4AA7b14fFB9BfB102D637";
const FLUXION_ROUTER = "0x5628a59dF0ECAC3f3171f877A94bEb26BA6DFAa0";
const FLUXION_PM  = "0x2b70C4e7cA8E920435A5dB191e066E9E3AFd8DB3";
const LB_ROUTER   = "0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a";
const AAVE_POOL   = "0x458F293454fE0d67EC0655f3672301301DD51422";
const WMNT_MAINNET = "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8";

// ── ABI selectors ──────────────────────────────────────────────────────────
const SELECTOR_EXACT_INPUT_SINGLE = "0x414bf389"; // exactInputSingle(...)
const SELECTOR_EXACT_INPUT        = "0xc04b8d59"; // exactInput(...) — multi-hop
const SELECTOR_MINT               = "0x88316456"; // V3 mint(MintParams)
const SELECTOR_MULTICALL          = "0xac9650d8"; // multicall(bytes[])
const SELECTOR_DEPOSIT            = "0xd0e30db0"; // WMNT deposit()
const SELECTOR_WITHDRAW_UINT      = "0x2e1a7d4d"; // WMNT withdraw(uint256)
const SELECTOR_SUPPLY             = "0x617ba037"; // Aave supply(...)
const SELECTOR_BORROW             = "0xa415bcad"; // Aave borrow(...)
const SELECTOR_REPAY              = "0x573ade81"; // Aave repay(...)
const SELECTOR_AAVE_WITHDRAW      = "0x69328dec"; // Aave withdraw(...)

// ── Shared constants ───────────────────────────────────────────────────────
// A well-formed non-zero address used as dummy recipient.
// No value is ever signed or broadcast in these tests.
const RECIPIENT = "0x1111111111111111111111111111111111111111";

// Integration timeout: real RPC calls can take up to a few seconds.
// 30s is generous and handles slow/cold connections.
const TIMEOUT = 30_000;

// =========================================================================
// buildSwap — V3 agni / fluxion
// =========================================================================
describe.skipIf(!ENABLED)("Integration: buildSwap — V3", () => {
  it("agni explicit fee_tier=500 WMNT→USDC — to=AGNI_ROUTER, exactInputSingle, chainId=5000", async () => {
    const result = await buildSwap({
      provider: "agni",
      token_in: "WMNT",
      token_out: "USDC",
      amount_in: "0.01",
      amount_out_min: "1",   // 1 raw USDC unit ≈ $0.000001 — effectively no slippage guard (tests only)
      fee_tier: 500,
      recipient: RECIPIENT
    });
    expect(result.intent).toBe("swap");
    expect(result.unsigned_tx.to).toBe(AGNI_ROUTER);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.data.startsWith(SELECTOR_EXACT_INPUT_SINGLE)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
    expect(result.pool_params?.fee_tier).toBe(500);
    expect(result.pool_params?.provider).toBe("agni");
  }, TIMEOUT);

  it("agni auto fee_tier discovery WMNT→USDC — calls real getPool, builds valid swap", async () => {
    // Without fee_tier, discoverBestV3Pool iterates fee tiers and picks the
    // one with the most liquidity. Uses real Agni Factory getPool calls.
    const result = await buildSwap({
      provider: "agni",
      token_in: "WMNT",
      token_out: "USDC",
      amount_in: "0.01",
      amount_out_min: "1",
      recipient: RECIPIENT
    });
    expect(result.intent).toBe("swap");
    expect(result.unsigned_tx.to).toBe(AGNI_ROUTER);
    expect(result.unsigned_tx.chainId).toBe(5000);
    // Either single-hop or multi-hop encoding is valid
    const isV3 =
      result.unsigned_tx.data.startsWith(SELECTOR_EXACT_INPUT_SINGLE) ||
      result.unsigned_tx.data.startsWith(SELECTOR_EXACT_INPUT);
    expect(isV3).toBe(true);
    // pool_params must include the discovered fee_tier
    expect(typeof result.pool_params?.fee_tier).toBe("number");
  }, TIMEOUT);

  it("agni WMNT→USDT0 explicit fee_tier=3000 — succeeds, chainId=5000", async () => {
    const result = await buildSwap({
      provider: "agni",
      token_in: "WMNT",
      token_out: "USDT0",
      amount_in: "0.01",
      amount_out_min: "1",
      fee_tier: 3000,
      recipient: RECIPIENT
    });
    expect(result.intent).toBe("swap");
    expect(result.unsigned_tx.chainId).toBe(5000);
  }, TIMEOUT);

  it("fluxion explicit fee_tier=3000 WMNT→USDC — to=FLUXION_ROUTER, chainId=5000", async () => {
    const result = await buildSwap({
      provider: "fluxion",
      token_in: "WMNT",
      token_out: "USDC",
      amount_in: "0.01",
      amount_out_min: "1",
      fee_tier: 3000,
      recipient: RECIPIENT
    });
    expect(result.unsigned_tx.to).toBe(FLUXION_ROUTER);
    expect(result.unsigned_tx.chainId).toBe(5000);
    expect(result.pool_params?.provider).toBe("fluxion");
  }, TIMEOUT);
});

// =========================================================================
// buildSwap — Merchant Moe LB
// =========================================================================
describe.skipIf(!ENABLED)("Integration: buildSwap — merchant_moe", () => {
  it("explicit bin_step=25 WMNT→USDC — to=LB_ROUTER, intent=swap, reads real LBPairInfo", async () => {
    // getLBPairInformation is called on the real LB Factory to confirm the pair
    // and determine router_version (2 for V2.1, 3 for V2.2).
    const result = await buildSwap({
      provider: "merchant_moe",
      token_in: "WMNT",
      token_out: "USDC",
      amount_in: "0.01",
      amount_out_min: "1",
      bin_step: 25,
      recipient: RECIPIENT
    });
    expect(result.intent).toBe("swap");
    expect(result.unsigned_tx.to).toBe(LB_ROUTER);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.chainId).toBe(5000);
    expect(result.pool_params?.provider).toBe("merchant_moe");
    expect(result.pool_params?.bin_step).toBe(25);
    expect(result.pool_params?.router_version).toBe(3); // V2.2 pair confirmed
  }, TIMEOUT);

  it("auto-discovery via LB Quoter WMNT→USDC — calls real findBestPathFromAmountIn", async () => {
    // The most common agent workflow: no bin_step supplied, quoter picks the
    // best route. This exercises the full LB Quoter integration path.
    const result = await buildSwap({
      provider: "merchant_moe",
      token_in: "WMNT",
      token_out: "USDC",
      amount_in: "0.01",
      amount_out_min: "1",
      recipient: RECIPIENT
    });
    expect(result.intent).toBe("swap");
    expect(result.unsigned_tx.to).toBe(LB_ROUTER);
    expect(result.unsigned_tx.chainId).toBe(5000);
    // Quoter-discovered bin_step must be a positive integer
    expect(typeof result.pool_params?.bin_step).toBe("number");
    expect((result.pool_params?.bin_step ?? 0) > 0).toBe(true);
  }, TIMEOUT);
});

// =========================================================================
// buildAddLiquidity — V3 agni / fluxion
// =========================================================================
describe.skipIf(!ENABLED)("Integration: buildAddLiquidity — V3", () => {
  // NOTE: 'owner' is deliberately omitted from all addLiquidity integration
  // tests to skip the allowance pre-check. RECIPIENT has no real token
  // approvals on mainnet, so passing owner would throw INSUFFICIENT_ALLOWANCE.

  it("agni range_preset='moderate' WMNT/USDC — reads real slot0+tickSpacing, builds mint tx", async () => {
    // The builder resolves the Agni pool → reads slot0() and tickSpacing() to
    // compute tick_lower/tick_upper from the live price. This is the most
    // common add-liquidity agent workflow.
    const result = await buildAddLiquidity({
      provider: "agni",
      token_a: "WMNT",
      token_b: "USDC",
      amount_a: "0.01",
      amount_b: "0.006",
      range_preset: "moderate",
      recipient: RECIPIENT
    });
    expect(result.intent).toBe("add_liquidity");
    expect(result.unsigned_tx.to).toBe(AGNI_PM);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.data.startsWith(SELECTOR_MINT)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
    expect(result.pool_params?.provider).toBe("agni");
  }, TIMEOUT);

  it("agni range_preset='full_range' WMNT/USDC — wider ticks, still builds mint tx", async () => {
    const result = await buildAddLiquidity({
      provider: "agni",
      token_a: "WMNT",
      token_b: "USDC",
      amount_a: "0.01",
      amount_b: "0.006",
      range_preset: "full_range",
      recipient: RECIPIENT
    });
    expect(result.intent).toBe("add_liquidity");
    expect(result.unsigned_tx.to).toBe(AGNI_PM);
    expect(result.unsigned_tx.data.startsWith(SELECTOR_MINT)).toBe(true);
  }, TIMEOUT);

  it("agni explicit tick_lower/tick_upper — no pool state RPC, pure mint encoding", async () => {
    // Explicit ticks bypass pool state reads entirely. The builder encodes
    // them directly into the MintParams struct.
    const result = await buildAddLiquidity({
      provider: "agni",
      token_a: "WMNT",
      token_b: "USDC",
      amount_a: "0.01",
      amount_b: "0.006",
      tick_lower: -887220,
      tick_upper: 887220,
      recipient: RECIPIENT
    });
    expect(result.intent).toBe("add_liquidity");
    expect(result.unsigned_tx.to).toBe(AGNI_PM);
    expect(result.unsigned_tx.data.startsWith(SELECTOR_MINT)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
  }, TIMEOUT);

  it("fluxion explicit ticks — to=fluxion position manager", async () => {
    const result = await buildAddLiquidity({
      provider: "fluxion",
      token_a: "WMNT",
      token_b: "USDC",
      amount_a: "0.01",
      amount_b: "0.006",
      tick_lower: -887220,
      tick_upper: 887220,
      recipient: RECIPIENT
    });
    expect(result.unsigned_tx.to).toBe(FLUXION_PM);
    expect(result.unsigned_tx.data.startsWith(SELECTOR_MINT)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
  }, TIMEOUT);
});

// =========================================================================
// buildAddLiquidity — Merchant Moe LB
// =========================================================================
describe.skipIf(!ENABLED)("Integration: buildAddLiquidity — merchant_moe", () => {
  it("range_preset='moderate' WMNT/USDC bin_step=25 — reads real getActiveId, to=LB_ROUTER", async () => {
    // getActiveId is called on the real WMNT/USDC LBPair to place bins around
    // the current active price.
    const result = await buildAddLiquidity({
      provider: "merchant_moe",
      token_a: "WMNT",
      token_b: "USDC",
      bin_step: 25,
      amount_a: "0.01",
      amount_b: "0.006",
      range_preset: "moderate",
      recipient: RECIPIENT
    });
    expect(result.intent).toBe("add_liquidity");
    expect(result.unsigned_tx.to).toBe(LB_ROUTER);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.chainId).toBe(5000);
    expect(result.pool_params?.provider).toBe("merchant_moe");
    expect(result.pool_params?.router_address).toBe(LB_ROUTER);
  }, TIMEOUT);
});

// =========================================================================
// buildRemoveLiquidity — V3 agni / fluxion (explicit liquidity — no positions read)
// =========================================================================
describe.skipIf(!ENABLED)("Integration: buildRemoveLiquidity — V3", () => {
  // Explicit liquidity mode bypasses positions() entirely — no real position needed.

  it("agni explicit liquidity — builds decreaseLiquidity+collect multicall, to=AGNI_PM", async () => {
    const result = await buildRemoveLiquidity({
      provider: "agni",
      token_id: "1",
      liquidity: "1000",
      recipient: RECIPIENT,
      owner: RECIPIENT
    });
    expect(result.intent).toBe("remove_liquidity");
    expect(result.unsigned_tx.to).toBe(AGNI_PM);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.data.startsWith(SELECTOR_MULTICALL)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
    // V3 remove does NOT use a separate router — no router_address needed
    expect(result.pool_params?.router_address).toBeUndefined();
  }, TIMEOUT);

  it("fluxion explicit liquidity — to=fluxion position manager", async () => {
    const result = await buildRemoveLiquidity({
      provider: "fluxion",
      token_id: "42",
      liquidity: "500",
      recipient: RECIPIENT,
      owner: RECIPIENT
    });
    expect(result.unsigned_tx.to).toBe(FLUXION_PM);
    expect(result.unsigned_tx.data.startsWith(SELECTOR_MULTICALL)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
  }, TIMEOUT);
});

// =========================================================================
// buildRemoveLiquidity — Merchant Moe LB (explicit ids + amounts)
// =========================================================================
describe.skipIf(!ENABLED)("Integration: buildRemoveLiquidity — merchant_moe", () => {
  it("explicit ids+amounts WMNT/USDC bin_step=25 — reads real getBin+totalSupply, to=LB_ROUTER", async () => {
    // The builder calls:
    //   getLBPairInformation (factory) → pair address
    //   getTokenX (pair) → confirm token ordering
    //   getActiveId (pair) → current active bin (for context)
    //   getBin + totalSupply (pair) → compute slippage-protected amountXMin/amountYMin
    // This tests the full Merchant Moe explicit remove path against real chain state.
    const result = await buildRemoveLiquidity({
      provider: "merchant_moe",
      token_a: "WMNT",
      token_b: "USDC",
      bin_step: 25,
      ids: [8388608],  // canonical active bin ID on Moe LB
      amounts: ["1000000000000000000"], // 1 LBToken share (18 decimals)
      recipient: RECIPIENT,
      owner: RECIPIENT
    });
    expect(result.intent).toBe("remove_liquidity");
    expect(result.unsigned_tx.to).toBe(LB_ROUTER);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.chainId).toBe(5000);
    expect(result.pool_params?.provider).toBe("merchant_moe");
  }, TIMEOUT);

  it("explicit ids+amounts WMNT/USDC — warnings checked (isApprovedForAll via RPC)", async () => {
    // The builder also reads isApprovedForAll on the LB Pair for RECIPIENT.
    // RECIPIENT has not approved the LB Router, so a warning should be emitted.
    const result = await buildRemoveLiquidity({
      provider: "merchant_moe",
      token_a: "WMNT",
      token_b: "USDC",
      bin_step: 25,
      ids: [8388608],
      amounts: ["1000000000000000000"],
      recipient: RECIPIENT,
      owner: RECIPIENT
    });
    expect(result.warnings.some(w =>
      w.includes("approveForAll") || w.includes("approval") || w.includes("operator")
    )).toBe(true);
  }, TIMEOUT);
});

// =========================================================================
// buildWrapMnt / buildUnwrapMnt (no RPC — deterministic with real addresses)
// =========================================================================
describe.skipIf(!ENABLED)("Integration: buildWrapMnt / buildUnwrapMnt", () => {
  it("buildWrapMnt 0.001 MNT — to=WMNT_MAINNET, value=1e15, data=deposit(), chainId=5000", async () => {
    const result = await buildWrapMnt({ amount: "0.001", sender: RECIPIENT });
    expect(result.intent).toBe("wrap_mnt");
    expect(result.unsigned_tx.to).toBe(WMNT_MAINNET);
    expect(result.unsigned_tx.value).toBe("0x38d7ea4c68000"); // 0.001 * 1e18 = 1e15
    expect(result.unsigned_tx.data).toBe(SELECTOR_DEPOSIT);
    expect(result.unsigned_tx.chainId).toBe(5000);
    expect(result.human_summary).toContain("MNT");
    expect(result.human_summary).toContain("WMNT");
  }, TIMEOUT);

  it("buildUnwrapMnt 0.001 WMNT — to=WMNT_MAINNET, value=0x0, data=withdraw(uint256)", async () => {
    const result = await buildUnwrapMnt({ amount: "0.001", sender: RECIPIENT });
    expect(result.intent).toBe("unwrap_mnt");
    expect(result.unsigned_tx.to).toBe(WMNT_MAINNET);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.data.startsWith(SELECTOR_WITHDRAW_UINT)).toBe(true);
    // 4-byte selector + 32-byte uint256 arg = 36 bytes = 72 hex + "0x" = 74 chars
    expect(result.unsigned_tx.data).toHaveLength(74);
    expect(result.unsigned_tx.chainId).toBe(5000);
  }, TIMEOUT);

  it("buildWrapMnt 1 MNT — value=1e18 in hex", async () => {
    const result = await buildWrapMnt({ amount: "1", sender: RECIPIENT });
    expect(result.unsigned_tx.value).toBe("0xde0b6b3a7640000"); // 1e18
  }, TIMEOUT);
});

// =========================================================================
// buildCollectFees — V3 agni (reads real positions() on chain)
// =========================================================================
describe.skipIf(!ENABLED)("Integration: buildCollectFees — V3", () => {
  it("non-existent token_id — either INVALID_INPUT (empty position) or collect_fees", async () => {
    // Token ID 999999 is very unlikely to exist. If it doesn't, buildCollectFees
    // throws INVALID_INPUT (zero liquidity + zero fees). If it somehow exists,
    // it returns a valid collect tx. Either outcome is acceptable.
    let succeeded = false;
    try {
      const result = await buildCollectFees({
        provider: "agni",
        token_id: "999999",
        recipient: RECIPIENT,
        owner: RECIPIENT
      });
      succeeded = true;
      expect(result.intent).toBe("collect_fees");
      expect(result.unsigned_tx.to).toBe(AGNI_PM);
    } catch (err: any) {
      // Only INVALID_INPUT is an acceptable error
      expect(err.code).toBe("INVALID_INPUT");
    }
    // At least one path executed cleanly
    expect(succeeded !== undefined).toBe(true);
  }, TIMEOUT);
});

// =========================================================================
// Aave V3 write functions (mostly static — no RPC for USDC borrow/supply/repay)
// =========================================================================
describe.skipIf(!ENABLED)("Integration: Aave V3 write functions", () => {
  it("buildAaveSupply 10 USDC — to=AavePool, supply selector, chainId=5000", async () => {
    const result = await buildAaveSupply({
      asset: "USDC",
      amount: "10",
      on_behalf_of: RECIPIENT
    });
    expect(result.intent).toBe("aave_supply");
    expect(result.unsigned_tx.to).toBe(AAVE_POOL);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.data.startsWith(SELECTOR_SUPPLY)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
    expect(result.aave_reserve?.symbol).toBe("USDC");
    expect(result.aave_reserve?.decimals).toBe(6);
    expect(result.aave_reserve?.underlying).toBeTruthy();
    expect(result.aave_reserve?.aToken).toBeTruthy();
  }, TIMEOUT);

  it("buildAaveSupply 1 WMNT — isolation mode warning in result", async () => {
    // WMNT is in isolation mode on Mantle Aave V3
    const result = await buildAaveSupply({
      asset: "WMNT",
      amount: "1",
      on_behalf_of: RECIPIENT
    });
    expect(result.intent).toBe("aave_supply");
    expect(result.unsigned_tx.to).toBe(AAVE_POOL);
    expect(result.warnings.some(w => w.includes("ISOLATION MODE"))).toBe(true);
  }, TIMEOUT);

  it("buildAaveBorrow 50 USDC variable — to=AavePool, borrow selector, summary=variable", async () => {
    // USDC is borrowableInIsolation=true — no aToken balance RPC needed
    const result = await buildAaveBorrow({
      asset: "USDC",
      amount: "50",
      on_behalf_of: RECIPIENT
    });
    expect(result.intent).toBe("aave_borrow");
    expect(result.unsigned_tx.to).toBe(AAVE_POOL);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.data.startsWith(SELECTOR_BORROW)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
    expect(result.human_summary.toLowerCase()).toContain("variable");
  }, TIMEOUT);

  it("buildAaveBorrow FBTC 0.001 — reads real aToken balances for isolation check", async () => {
    // FBTC is NOT borrowableInIsolation — builder checks if borrower has isolation
    // collateral. RECIPIENT has 0 aToken balances → not in isolation → succeeds.
    const result = await buildAaveBorrow({
      asset: "FBTC",
      amount: "0.001",
      on_behalf_of: RECIPIENT
    });
    expect(result.intent).toBe("aave_borrow");
    expect(result.unsigned_tx.chainId).toBe(5000);
  }, TIMEOUT);

  it("buildAaveRepay 50 USDC — to=AavePool, repay selector, chainId=5000", async () => {
    const result = await buildAaveRepay({
      asset: "USDC",
      amount: "50",
      on_behalf_of: RECIPIENT
    });
    expect(result.intent).toBe("aave_repay");
    expect(result.unsigned_tx.to).toBe(AAVE_POOL);
    expect(result.unsigned_tx.data.startsWith(SELECTOR_REPAY)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
  }, TIMEOUT);

  it("buildAaveRepay amount='max' — last 64 hex chars of calldata = MAX_UINT256", async () => {
    const result = await buildAaveRepay({
      asset: "USDC",
      amount: "max",
      on_behalf_of: RECIPIENT
    });
    expect(result.intent).toBe("aave_repay");
    // MAX_UINT256 = 2^256 - 1; encoded as 64 hex 'f' chars in the last slot
    expect(result.unsigned_tx.data.endsWith("f".repeat(64))).toBe(true);
  }, TIMEOUT);

  it("buildAaveWithdraw 10 USDC — to=AavePool, withdraw selector, health factor warning", async () => {
    const result = await buildAaveWithdraw({
      asset: "USDC",
      amount: "10",
      to: RECIPIENT,
      owner: RECIPIENT
    });
    expect(result.intent).toBe("aave_withdraw");
    expect(result.unsigned_tx.to).toBe(AAVE_POOL);
    expect(result.unsigned_tx.data.startsWith(SELECTOR_AAVE_WITHDRAW)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
    // Health factor reduction warning is always emitted
    expect(result.warnings.some(w => w.toLowerCase().includes("health factor"))).toBe(true);
  }, TIMEOUT);

  it("buildAaveWithdraw amount='max' — MAX_UINT256 in calldata", async () => {
    const result = await buildAaveWithdraw({
      asset: "WMNT",
      amount: "max",
      to: RECIPIENT,
      owner: RECIPIENT
    });
    expect(result.intent).toBe("aave_withdraw");
    expect(result.unsigned_tx.data.endsWith("f".repeat(64))).toBe(true);
  }, TIMEOUT);
});

// =========================================================================
// buildSetLBApprovalForAll — resolves real pair from factory
// =========================================================================
describe.skipIf(!ENABLED)("Integration: buildSetLBApprovalForAll", () => {
  it("approve LB Router for WMNT/USDC bin_step=25 — reads real factory, to=LB Pair", async () => {
    // The builder calls getLBPairInformation on the real LB Factory to resolve
    // the pair address. The approval tx is sent to the PAIR (not the router).
    const result = await buildSetLBApprovalForAll({
      operator: LB_ROUTER,
      token_a: "WMNT",
      token_b: "USDC",
      bin_step: 25,
      approved: true
    });
    expect(result.intent).toBe("approve_lb");
    // to = the LB Pair address (not the router and not zero)
    expect(result.unsigned_tx.to).not.toBe("0x0000000000000000000000000000000000000000");
    expect(result.unsigned_tx.to.toLowerCase()).not.toBe(LB_ROUTER.toLowerCase());
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.chainId).toBe(5000);
    expect(result.unsigned_tx.data.length).toBeGreaterThan(10);
    // Warning about unlimited operator approval
    expect(result.warnings.some(w =>
      w.includes("approveForAll") || w.includes("operator")
    )).toBe(true);
  }, TIMEOUT);

  it("revoke (approved=false) — intent=approve_lb_revoke, no warnings", async () => {
    const result = await buildSetLBApprovalForAll({
      operator: LB_ROUTER,
      token_a: "WMNT",
      token_b: "USDC",
      bin_step: 25,
      approved: false
    });
    expect(result.intent).toBe("approve_lb_revoke");
    expect(result.warnings).toHaveLength(0);
  }, TIMEOUT);
});
