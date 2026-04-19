# Dev Branch — What's New vs Main

This document describes features that are **available in `dev` but not yet merged into `main`**.  
It is intended for external contributors and early adopters who want to build on the latest work.

> **Branch:** `dev` → tracked at `origin/dev`  
> **Base:** branched from `main` at commit `2156e28` (v0.1.18)

---

## Quick Summary

| Area | Change |
|------|--------|
| Token registry | 29 tokens with on-chain-verified decimals (was 6) |
| Pool discovery | Zero-RPC local snapshot; single-side token query |
| Whitelist | Hard-enforced OpenClaw × Mantle asset/contract whitelist |
| New CLI tree | `mantle-cli whitelist` with 5 subcommands |
| Revert decoding | Structured error enrichment for gas-estimation failures |
| Swap safety | `--minimum-out` accepts decimal OR raw integer; negative/zero guards |
| DEX coverage | Merchant Moe V1 AMM pools added (6 new pairs) |
| CLI cleanup | 4 dead/redundant commands removed; shared `formatUnsignedTx` helper |
| Aave fix | Missing `pool_addresses_provider` added — `aave markets` now works |
| Maintenance scripts | 5 new on-chain verification and registry refresh scripts |

---

## 1. Token Registry Unification

**Commits:** `5b2e03e` · **PR #14**

Previously `registry.json` covered only 6 tokens while `tokens.ts` held 29.
Dev unifies them:

- Every ERC-20 in `tokens.ts` is now in `registry.json` with a `decimals` field verified on-chain (0 mismatches across mainnet + Sepolia).
- `mantle_resolveAddress` response now includes `decimals` for token entries.
- CLI `registry resolve <TOKEN>` renders `decimals` for the token category.
- A new Vitest parity test (`tests/registry-tools.test.ts`) asserts every token in `MANTLE_TOKENS` resolves through the registry with matching checksummed address and decimals — guards against future drift.
- 12 addresses normalized to canonical EIP-55 checksums.

```bash
# Before (main): no decimals in response
mantle-cli registry resolve USDC --json

# After (dev): includes decimals field
mantle-cli registry resolve USDC --json
# → { "address": "0x09Bc4E0D864854c6aFb6eB9A9cdF58aC190D0dF", "decimals": 6, ... }
```

**New maintenance scripts:**

```bash
node scripts/verify-tokens.mjs            # on-chain verify all token decimals/symbols
node scripts/check-registry-checksums.mjs # assert EIP-55 for every address
node scripts/check-registry-parity.mjs   # tokens.ts vs registry.json cross-check
```

---

## 2. Zero-RPC Pool Discovery

**Commits:** `b5378c1` · **PR #15**

`mantle_findPools` / `mantle-cli lp find-pools` previously made **100–300 RPC calls** per invocation (on-chain `getPool` / `getLBPairInformation` scan). Dev replaces this with a synchronous read of a bundled local snapshot.

### What changed

| | Main | Dev |
|---|---|---|
| Pool discovery path | 100–300 live RPC calls | Synchronous local snapshot read |
| DexScreener HTTP | Used for pool discovery | Used only for TVL/volume enrichment on already-found pools |
| Response field `liquidity_unit` | `"usd"` | `"dexscreener_usd_snapshot"` |
| New response field | — | `snapshot_meta: { fetched_at, total_pools }` |
| New response field | — | `pool_sources` — which local sources were consulted |

### Refreshing the snapshot

The snapshot lives at `packages/core/src/config/dexscreener-pools.json`.  
When you need to pick up new pools, run:

```bash
node scripts/refresh-pools.mjs
```

This fetches DexScreener Mantle pools, filters by the whitelist, verifies each candidate on-chain (ERC-20 symbol, V3 token0/1/fee, LB binStep), then atomically rewrites the snapshot.

---

## 3. Single-Side Pool Query

**Commits:** `98a58a2` · **PR #13**

You can now query all pools containing a single token without knowing the counterpart:

```bash
# Main: must supply both token_a AND token_b
mantle-cli lp find-pools --token-a USDC --token-b WMNT --json

# Dev: supply only one token to enumerate every pool for that anchor
mantle-cli lp find-pools --token-a USDC --json
```

New response fields (additive, pair mode is unchanged):

| Field | Description |
|-------|-------------|
| `mode` | `"pair"` or `"single_side"` |
| `anchor_token` | The query token (populated in both modes) |
| `scanned.counterparts_scanned` | Number of counterpart tokens examined |
| `scanned.counterpart_sources` | Where counterparts came from (snapshot / pairs / token-list) |
| per-pool `token_a` / `token_b` | Anchor-ordered in single-side mode |

**Breaking change:** `{ token_a: X, token_b: X }` (same-token self-pair) now throws `INVALID_INPUT` instead of returning empty.

---

## 4. OpenClaw × Mantle Whitelist Enforcement

**Commits:** `2618172` · **PR #16**

Write-side tools (swap, approve, LP, Aave) now **refuse** any token or contract target that is not on the official OpenClaw × Mantle competition whitelist — even when supplied as a raw address:

- 29 whitelisted ERC-20 tokens
- 20 whitelisted protocol contracts

```bash
# Attempt to use a non-whitelisted token → hard INVALID_INPUT error
mantle-cli defi swap --token-in SOME_RANDOM_TOKEN --token-out USDC ...
# → { "error": "INVALID_INPUT", "message": "Token 'SOME_RANDOM_TOKEN' is not on the whitelist." }
```

Read-only tools (`getSwapQuote`, `getPoolLiquidity`, etc.) are **unaffected** — they continue to work with any valid address.

---

## 5. `whitelist` CLI Command Tree

**Commits:** `2618172` · **PR #16**

A new top-level command for inspecting the active whitelist incrementally:

```bash
mantle-cli whitelist --help
```

### Subcommands

| Subcommand | Purpose |
|------------|---------|
| `mantle-cli whitelist summary --json` | Schema version, total counts by category, protocol group list |
| `mantle-cli whitelist tokens --json` | All whitelisted tokens with address, decimals, status |
| `mantle-cli whitelist contracts --json` | Whitelisted contracts grouped by category (defi / bridge / system) |
| `mantle-cli whitelist protocols --json` | Protocol groups and the contract keys inside each |
| `mantle-cli whitelist show <key\|alias\|address> --json` | Full entry details — resolves by key, alias, label, or raw address |

All subcommands support `--network mainnet|sepolia` and `--json`.

### Example

```bash
# Check if a contract is whitelisted and see its metadata
mantle-cli whitelist show 0x319B69888b0d11cEC22caA5034e25FfFBDc88421 --json
# → { "key": "agni_swap_router", "label": "Agni SwapRouter", "category": "defi", ... }

# List all whitelisted tokens
mantle-cli whitelist tokens --json
```

---

## 6. Structured Revert Decoding

**Commits:** `2618172` · **PR #16**

Previously, when `mantle_estimateGas` or a DeFi build tool failed during gas estimation, agents received an opaque `GAS_ESTIMATION_FAILED` error with no visibility into the on-chain revert reason.

Dev adds **`revert-decoder.ts`** — a library that walks viem's error cause chain and decodes:

| Revert type | Decoded fields |
|------------|----------------|
| Standard `Error(string)` (selector `0x08c379a0`) | `revert_name: "Error"`, `revert_message: "..."` |
| Standard `Panic(uint256)` (selector `0x4e487b71`) | `revert_name: "Panic"`, `revert_args: [code]` |
| Known Aave V3 custom errors | `revert_name: "<AaveErrorName>"` |
| Unknown selector | `revert_raw: "0x..."`, `revert_selector: "0xabcd1234"` |

These fields appear in the `details` object of every `GAS_ESTIMATION_FAILED` error and in the error `message` as a `[revert: ...]` suffix:

```json
{
  "error": "GAS_ESTIMATION_FAILED",
  "message": "Gas estimation failed [revert: SafeERC20: low-level call failed]",
  "details": {
    "revert_raw": "0x08c379a0...",
    "revert_selector": "0x08c379a0",
    "revert_name": "Error",
    "revert_message": "SafeERC20: low-level call failed"
  }
}
```

Unknown selectors can be looked up externally (e.g., [4byte.directory](https://www.4byte.directory)) rather than forcing the agent to guess.

---

## 7. Dual-Format `--minimum-out` for Swap

**Commits:** `87d1bab`, `c5f3604`

`mantle_buildSwap` / `mantle-cli defi swap --minimum-out` now accepts **both** formats interchangeably:

| Format | Example | Behavior |
|--------|---------|----------|
| Decimal string | `"0.5"` | `parseUnits("0.5", decimals)` — precision > decimals is rejected |
| Raw integer string | `"500000"` | Used verbatim as BigInt |

The canonical flag is now `--minimum-out` (`--amount-out-min` kept as a backward-compatible alias).

A `slippage_protection` echo field is always present in swap output so callers can verify the resolved raw value:

```json
{
  "slippage_protection": {
    "input_raw_or_decimal": "0.5",
    "resolved_raw": "500000",
    "resolved_decimal": "0.5",
    "token_out_decimals": 6
  }
}
```

**Safety guards added:**
- Negative decimals (e.g., `"-0.5"`) → `INVALID_AMOUNT_FORMAT`
- Decimal-form zeros (e.g., `"0.0"`) → `INVALID_AMOUNT_FORMAT`
- Whitespace-only input → `INVALID_AMOUNT_FORMAT`

---

## 8. Merchant Moe V1 AMM Support

**Commits:** `d4cc396`

The pool registry now includes Merchant Moe's classic V1 AMM pools alongside LB v2 and V3 pools.  
The LB Router V2.2 can route through V1 pools natively.

**6 new V1 AMM pairs:**

| Pair | Note |
|------|------|
| MOE / WMNT | |
| MOE / USDT | |
| WETH / USDC | |
| cmETH / WMNT | |
| USDe / WMNT | |
| FBTC / WMNT | |

V1 pools do not expose `bin_step` or `fee_tier` — LB-only paths filter them out automatically.

**New on-chain verification script:**

```bash
node scripts/verify-dex-pairs.mjs
# Cross-checks every entry in dex-pairs.ts against on-chain state
# (token0/1, symbol, binStep / feeTier) — currently 268 passes, 0 errors
```

---

## 9. CLI Command Cleanup

**Commits:** `6866240`

Four redundant or dead commands were removed. If you were using them, here are the replacements:

| Removed command | Use instead |
|-----------------|-------------|
| `mantle-cli defi analyze-pool` | `mantle-cli lp analyze` |
| `mantle-cli defi lending-markets` | `mantle-cli aave markets` |
| `mantle-cli lp lb-positions` | `mantle-cli lp positions --provider merchant_moe` |
| `mantle-cli lp top-pools` | (was dead code — no replacement) |

A shared `formatUnsignedTx()` helper was extracted to `formatter.ts`, eliminating ~60 lines of duplicated rendering code across the swap, approve, LP, and Aave command modules.

---

## 10. Aave V3 `lending-markets` / `aave markets` Fix

**Commits:** `92fb8d1`

The Aave V3 read path requires `pool_addresses_provider` (for PriceOracle lookup). This address was missing from the Mantle protocol registry, causing every invocation of `aave markets` on mainnet to fail with `LENDING_DATA_UNAVAILABLE`.

The official Mantle Pool Addresses Provider (`0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f`) has been added. **`aave markets` now works correctly on mainnet.**

---

## 11. Merchant Moe Multi-Version Swap Signing Test

**Commits:** `aa4109e`

A new signing-test scenario (`scenario-moe-swap.ts`) validates the full live swap path across all three Merchant Moe router versions:

```bash
cd scripts/signing-test
npm run test:moe-swap:dry   # dry run — no gas needed
npm run test:moe-swap       # live — signs and broadcasts on Mantle mainnet
```

Three paths tested:
1. **V2.2 direct** — explicit `bin_step` to a known V2.2 pair
2. **V2.2 auto** — auto-routing via the V2.2 router
3. **V1 AMM** — route through a classic V1 AMM pool via V2.2 router

---

## Getting Started on dev

```bash
git clone <repo>
git checkout dev
npm install
npm run build
```

Verify everything passes:

```bash
npm test
```

Try the new whitelist inspection:

```bash
mantle-cli whitelist summary --json
mantle-cli whitelist tokens --json
mantle-cli whitelist show agni_swap_router --json
```

Try single-side pool discovery:

```bash
mantle-cli lp find-pools --token-a USDC --json
```

---

## Known Differences from main

- `package-lock.json` may diverge slightly due to the additional `skills/` submodule bump commits on dev.
- The `dexscreener-pools.json` snapshot was regenerated with a whitelist filter; the pool count may differ from a raw DexScreener fetch.
- `tests/resources.test.ts` on dev was updated to assert the 5 whitelisted protocols rather than the old Ondo-planned assertion.
