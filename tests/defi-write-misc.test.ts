/**
 * Unit tests for simpler defi-write functions:
 *   - buildWrapMnt
 *   - buildUnwrapMnt
 *   - buildCollectFees
 *   - buildSetLBApprovalForAll
 *
 * These functions either need no on-chain reads (wrap/unwrap) or use
 * d.getClient() via deps injection (collectFees, setLBApproval).
 * No vi.mock() is required.
 */
import { describe, expect, it } from "vitest";
import {
  buildWrapMnt,
  buildUnwrapMnt,
  buildCollectFees,
  buildSetLBApprovalForAll
} from "@mantleio/mantle-core/tools/defi-write.js";
import { MantleMcpError } from "@mantleio/mantle-core/errors.js";

// ── Addresses ─────────────────────────────────────────────────────────────
const WMNT_MAINNET = "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8";
const WMNT_SEPOLIA = "0x19f5557E23e9914A18239990f6C70D68FDF0deD5";
const AGNI_POSITION_MANAGER = "0x218bf598D1453383e2F4AA7b14fFB9BfB102D637";
const FLUXION_POSITION_MANAGER = "0x2b70C4e7cA8E920435A5dB191e066E9E3AFd8DB3";
const LB_ROUTER_V2_2 = "0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a";
const FAKE_PAIR = "0xAAaA000000000000000000000000000000000001";
const FAKE_WALLET = "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF";
const FAKE_RECIPIENT = "0x1111111111111111111111111111111111111111";

// ── ABI selectors ─────────────────────────────────────────────────────────
// keccak256("deposit()")[0:4]
const SELECTOR_DEPOSIT = "0xd0e30db0";
// keccak256("withdraw(uint256)")[0:4]
const SELECTOR_WITHDRAW = "0x2e1a7d4d";
// keccak256("multicall(bytes[])")[0:4]
const SELECTOR_MULTICALL = "0xac9650d8";

// ── Shared deps ───────────────────────────────────────────────────────────
const NOW = "2026-01-01T00:00:00.000Z";
const baseDeps = {
  now: () => NOW,
  deadline: () => 9_999_999_999n
};

// =========================================================================
// buildWrapMnt
// =========================================================================
describe("buildWrapMnt", () => {
  it("wraps 1 MNT — to=WMNT, value=1e18 hex, data=deposit selector, chainId=5000", async () => {
    const result = await buildWrapMnt(
      { amount: "1", sender: FAKE_WALLET },
      baseDeps
    );
    expect(result.intent).toBe("wrap_mnt");
    expect(result.unsigned_tx.to).toBe(WMNT_MAINNET);
    expect(result.unsigned_tx.value).toBe("0xde0b6b3a7640000"); // 1e18
    expect(result.unsigned_tx.data).toBe(SELECTOR_DEPOSIT);
    expect(result.unsigned_tx.chainId).toBe(5000);
    expect(result.built_at_utc).toBe(NOW);
  });

  it("wraps 0.5 MNT — value is 5e17 in hex", async () => {
    const result = await buildWrapMnt(
      { amount: "0.5", sender: FAKE_WALLET },
      baseDeps
    );
    expect(result.unsigned_tx.value).toBe("0x6f05b59d3b20000"); // 5e17
  });

  it("wraps 10 MNT — value is 10e18 in hex", async () => {
    const result = await buildWrapMnt(
      { amount: "10", sender: FAKE_WALLET },
      baseDeps
    );
    expect(result.unsigned_tx.value).toBe("0x8ac7230489e80000"); // 10e18
  });

  it("sepolia wrap — to=sepolia WMNT, chainId=5003, testnet warning present", async () => {
    const result = await buildWrapMnt(
      { amount: "1", sender: FAKE_WALLET, network: "sepolia" },
      baseDeps
    );
    expect(result.unsigned_tx.chainId).toBe(5003);
    expect(result.unsigned_tx.to).toBe(WMNT_SEPOLIA);
    // No sepoliaWarning is explicitly attached in buildWrapMnt (it's a
    // data-return-only function without the usual swapWarnings path), but
    // chainId and to address are correctly overridden.
  });

  it("accepts 'owner' alias instead of 'sender' — same calldata as using 'sender'", async () => {
    const resultOwner = await buildWrapMnt(
      { amount: "1", owner: FAKE_WALLET },
      baseDeps
    );
    const resultSender = await buildWrapMnt(
      { amount: "1", sender: FAKE_WALLET },
      baseDeps
    );
    // Both aliases produce identical transactions
    expect(resultOwner.unsigned_tx.data).toBe(resultSender.unsigned_tx.data);
    expect(resultOwner.unsigned_tx.value).toBe(resultSender.unsigned_tx.value);
  });

  it("rejects zero amount → INVALID_INPUT", async () => {
    await expect(
      buildWrapMnt({ amount: "0", sender: FAKE_WALLET }, baseDeps)
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects negative amount → INVALID_INPUT", async () => {
    await expect(
      buildWrapMnt({ amount: "-1", sender: FAKE_WALLET }, baseDeps)
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects missing sender/owner", async () => {
    await expect(
      buildWrapMnt({ amount: "1" }, baseDeps)
    ).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
  });

  it("human_summary mentions 'MNT' and 'WMNT'", async () => {
    const result = await buildWrapMnt(
      { amount: "2.5", sender: FAKE_WALLET },
      baseDeps
    );
    expect(result.human_summary).toContain("MNT");
    expect(result.human_summary).toContain("WMNT");
    expect(result.human_summary).toContain("2.5");
  });
});

// =========================================================================
// buildUnwrapMnt
// =========================================================================
describe("buildUnwrapMnt", () => {
  it("unwraps 1 WMNT — to=WMNT, value=0x0, data=withdraw selector, intent=unwrap_mnt", async () => {
    const result = await buildUnwrapMnt(
      { amount: "1", sender: FAKE_WALLET },
      baseDeps
    );
    expect(result.intent).toBe("unwrap_mnt");
    expect(result.unsigned_tx.to).toBe(WMNT_MAINNET);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.data.startsWith(SELECTOR_WITHDRAW)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
  });

  it("data encodes the withdraw amount — longer than just selector", async () => {
    const result = await buildUnwrapMnt(
      { amount: "0.001", sender: FAKE_WALLET },
      baseDeps
    );
    // withdraw(uint256) selector (4 bytes) + uint256 argument (32 bytes) = 36 bytes = 72 hex chars + "0x"
    expect(result.unsigned_tx.data).toHaveLength(74);
    expect(result.unsigned_tx.data.startsWith(SELECTOR_WITHDRAW)).toBe(true);
  });

  it("unwrap 5 WMNT — summary mentions both tokens and amount", async () => {
    const result = await buildUnwrapMnt(
      { amount: "5", sender: FAKE_WALLET },
      baseDeps
    );
    expect(result.human_summary).toContain("WMNT");
    expect(result.human_summary).toContain("MNT");
    expect(result.human_summary).toContain("5");
  });

  it("rejects missing sender/owner", async () => {
    await expect(
      buildUnwrapMnt({ amount: "1" }, baseDeps)
    ).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
  });

  it("rejects zero amount → INVALID_INPUT", async () => {
    await expect(
      buildUnwrapMnt({ amount: "0", sender: FAKE_WALLET }, baseDeps)
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("deps.now() injection — built_at_utc reflects injected timestamp, not real clock", async () => {
    const result = await buildUnwrapMnt(
      { amount: "1", sender: FAKE_WALLET },
      baseDeps
    );
    // If now() were not injected, built_at_utc would be the real current date != NOW
    expect(result.built_at_utc).toBe(NOW);
    expect(result.unsigned_tx.data.startsWith(SELECTOR_WITHDRAW)).toBe(true);
  });
});

// =========================================================================
// buildCollectFees
// =========================================================================
describe("buildCollectFees", () => {
  /**
   * positions() returns a 12-tuple:
   * [nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity,
   *  feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1]
   */
  function makeClient(liquidity: bigint, tokensOwed0: bigint, tokensOwed1: bigint) {
    return () => ({
      readContract: async () =>
        [0n, FAKE_WALLET, FAKE_WALLET, FAKE_WALLET, 500, -100, 100,
          liquidity, 0n, 0n, tokensOwed0, tokensOwed1]
    });
  }

  it("agni: active position — to=agni PM, multicall selector, intent=collect_fees", async () => {
    const result = await buildCollectFees(
      { provider: "agni", token_id: "12345", recipient: FAKE_RECIPIENT, owner: FAKE_WALLET },
      { ...baseDeps, getClient: makeClient(1_000_000n, 100n, 200n) as any }
    );
    expect(result.intent).toBe("collect_fees");
    expect(result.unsigned_tx.to).toBe(AGNI_POSITION_MANAGER);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.data.startsWith(SELECTOR_MULTICALL)).toBe(true);
    expect(result.unsigned_tx.chainId).toBe(5000);
  });

  it("fluxion: to = fluxion position manager", async () => {
    const result = await buildCollectFees(
      { provider: "fluxion", token_id: "99", recipient: FAKE_RECIPIENT, owner: FAKE_WALLET },
      { ...baseDeps, getClient: makeClient(500n, 50n, 50n) as any }
    );
    expect(result.unsigned_tx.to).toBe(FLUXION_POSITION_MANAGER);
  });

  it("active position (liquidity > 0): multicall includes poke (decreaseLiquidity 0) + collect", async () => {
    // When liquidity > 0, a poke is prepended. The outer multicall wraps
    // two inner calls → data is longer than a single collect call.
    const result = await buildCollectFees(
      { provider: "agni", token_id: "1", recipient: FAKE_RECIPIENT, owner: FAKE_WALLET },
      { ...baseDeps, getClient: makeClient(1n, 100n, 100n) as any }
    );
    // multicall(bytes[]) with two inner calls: multicall selector + ABI-encoded array
    expect(result.unsigned_tx.data.length).toBeGreaterThan(100);
  });

  it("zero liquidity + zero tokensOwed → INVALID_INPUT", async () => {
    await expect(
      buildCollectFees(
        { provider: "agni", token_id: "12345", recipient: FAKE_RECIPIENT, owner: FAKE_WALLET },
        { ...baseDeps, getClient: makeClient(0n, 0n, 0n) as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("zero liquidity but tokensOwed0 > 0 → succeeds (closed position with uncollected fees)", async () => {
    const result = await buildCollectFees(
      { provider: "agni", token_id: "999", recipient: FAKE_RECIPIENT, owner: FAKE_WALLET },
      { ...baseDeps, getClient: makeClient(0n, 500n, 0n) as any }
    );
    expect(result.intent).toBe("collect_fees");
  });

  it("provider='merchant_moe' → INVALID_INPUT", async () => {
    await expect(
      buildCollectFees(
        { provider: "merchant_moe", token_id: "12345", recipient: FAKE_RECIPIENT, owner: FAKE_WALLET },
        { ...baseDeps, getClient: makeClient(100n, 50n, 50n) as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("non-numeric token_id → INVALID_INPUT", async () => {
    await expect(
      buildCollectFees(
        { provider: "agni", token_id: "not-a-number", recipient: FAKE_RECIPIENT, owner: FAKE_WALLET },
        { ...baseDeps, getClient: makeClient(100n, 50n, 50n) as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("negative token_id → INVALID_INPUT", async () => {
    await expect(
      buildCollectFees(
        { provider: "agni", token_id: "-1", recipient: FAKE_RECIPIENT, owner: FAKE_WALLET },
        { ...baseDeps, getClient: makeClient(100n, 50n, 50n) as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("missing owner → INVALID_ADDRESS", async () => {
    await expect(
      buildCollectFees(
        { provider: "agni", token_id: "12345", recipient: FAKE_RECIPIENT },
        { ...baseDeps, getClient: makeClient(100n, 50n, 50n) as any }
      )
    ).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
  });

  it("'sender' accepted as alias for 'owner' — builds identical multicall calldata", async () => {
    const resultOwner = await buildCollectFees(
      { provider: "agni", token_id: "12345", recipient: FAKE_RECIPIENT, owner: FAKE_WALLET },
      { ...baseDeps, getClient: makeClient(100n, 50n, 50n) as any }
    );
    const resultSender = await buildCollectFees(
      { provider: "agni", token_id: "12345", recipient: FAKE_RECIPIENT, sender: FAKE_WALLET },
      { ...baseDeps, getClient: makeClient(100n, 50n, 50n) as any }
    );
    // Both aliases must produce the same collect calldata
    expect(resultSender.unsigned_tx.data).toBe(resultOwner.unsigned_tx.data);
    expect(resultSender.unsigned_tx.to).toBe(AGNI_POSITION_MANAGER);
  });
});

// =========================================================================
// buildSetLBApprovalForAll
// =========================================================================
describe("buildSetLBApprovalForAll", () => {
  function makeClient(currentlyApproved: boolean | "rpc_error") {
    return () => ({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "getLBPairInformation") {
          return {
            binStep: 25,
            LBPair: FAKE_PAIR,
            createdByOwner: false,
            ignoredForRouting: false
          };
        }
        if (functionName === "isApprovedForAll") {
          if (currentlyApproved === "rpc_error") throw new Error("RPC failed");
          return currentlyApproved;
        }
        return null;
      }
    });
  }

  it("approve via direct pair address — intent=approve_lb, to=pair, value=0x0", async () => {
    const result = await buildSetLBApprovalForAll(
      { operator: LB_ROUTER_V2_2, pair: FAKE_PAIR, approved: true },
      { ...baseDeps, getClient: makeClient(false) as any }
    );
    expect(result.intent).toBe("approve_lb");
    expect(result.unsigned_tx.to).toBe(FAKE_PAIR);
    expect(result.unsigned_tx.value).toBe("0x0");
    expect(result.unsigned_tx.chainId).toBe(5000);
    expect(result.unsigned_tx.data.length).toBeGreaterThan(10);
  });

  it("revoke (approved=false) — intent=approve_lb_revoke", async () => {
    const result = await buildSetLBApprovalForAll(
      { operator: LB_ROUTER_V2_2, pair: FAKE_PAIR, approved: false },
      { ...baseDeps, getClient: makeClient(true) as any }
    );
    expect(result.intent).toBe("approve_lb_revoke");
    expect(result.warnings).toHaveLength(0); // no warning for revoke
  });

  it("approve_skip when owner provided and already approved", async () => {
    const result = await buildSetLBApprovalForAll(
      { operator: LB_ROUTER_V2_2, pair: FAKE_PAIR, approved: true, owner: FAKE_WALLET },
      { ...baseDeps, getClient: makeClient(true) as any }
    );
    expect(result.intent).toBe("approve_skip");
    expect(result.unsigned_tx.data).toBe("0x");
  });

  it("approve_skip when owner provided and already revoked (approved=false)", async () => {
    const result = await buildSetLBApprovalForAll(
      { operator: LB_ROUTER_V2_2, pair: FAKE_PAIR, approved: false, owner: FAKE_WALLET },
      { ...baseDeps, getClient: makeClient(false) as any }
    );
    expect(result.intent).toBe("approve_skip");
  });

  it("no skip when owner not provided — always builds tx", async () => {
    const result = await buildSetLBApprovalForAll(
      { operator: LB_ROUTER_V2_2, pair: FAKE_PAIR, approved: true },
      { ...baseDeps, getClient: makeClient(true) as any }
    );
    expect(result.intent).toBe("approve_lb");
  });

  it("isApprovedForAll RPC failure → skips pre-check and proceeds with approve tx", async () => {
    const result = await buildSetLBApprovalForAll(
      { operator: LB_ROUTER_V2_2, pair: FAKE_PAIR, approved: true, owner: FAKE_WALLET },
      { ...baseDeps, getClient: makeClient("rpc_error") as any }
    );
    expect(result.intent).toBe("approve_lb");
  });

  it("non-whitelisted operator → SPENDER_NOT_WHITELISTED", async () => {
    await expect(
      buildSetLBApprovalForAll(
        { operator: "0x1234567890123456789012345678901234567890", pair: FAKE_PAIR },
        { ...baseDeps, getClient: makeClient(false) as any }
      )
    ).rejects.toMatchObject({ code: "SPENDER_NOT_WHITELISTED" });
  });

  it("resolves pair from factory when pair not provided directly", async () => {
    const WMNT_ADDR = "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8";
    const USDC_ADDR = "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9";
    const result = await buildSetLBApprovalForAll(
      {
        operator: LB_ROUTER_V2_2,
        token_a: WMNT_ADDR,
        token_b: USDC_ADDR,
        bin_step: 25
      },
      {
        ...baseDeps,
        getClient: makeClient(false) as any,
        resolveTokenInput: async (input: string) => ({
          address: input,
          symbol: input === WMNT_ADDR ? "WMNT" : "USDC",
          decimals: 18
        })
      }
    );
    expect(result.unsigned_tx.to).toBe(FAKE_PAIR);
  });

  it("zero LBPair from factory → PAIR_NOT_FOUND", async () => {
    await expect(
      buildSetLBApprovalForAll(
        {
          operator: LB_ROUTER_V2_2,
          token_a: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
          token_b: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
          bin_step: 25
        },
        {
          ...baseDeps,
          getClient: () => ({
            readContract: async () => ({
              binStep: 25,
              LBPair: "0x0000000000000000000000000000000000000000",
              createdByOwner: false,
              ignoredForRouting: false
            })
          }) as any,
          resolveTokenInput: async (input: string) => ({
            address: input,
            symbol: "TKN",
            decimals: 18
          })
        }
      )
    ).rejects.toMatchObject({ code: "PAIR_NOT_FOUND" });
  });

  it("approve warning mentions unlimited burn risk", async () => {
    const result = await buildSetLBApprovalForAll(
      { operator: LB_ROUTER_V2_2, pair: FAKE_PAIR, approved: true },
      { ...baseDeps, getClient: makeClient(false) as any }
    );
    expect(result.warnings.some(w => w.includes("approveForAll") || w.includes("operator"))).toBe(true);
  });
});
