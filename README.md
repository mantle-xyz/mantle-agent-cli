# mantle-agent-scaffold

Mantle L2 tooling for AI agents. Provides read and write tools for DeFi operations on Mantle L2 — swap, LP, lending (Aave V3), token approvals, and more. All write tools return unsigned transaction payloads; they never hold private keys or broadcast.

Supported protocols: **Merchant Moe** (V1 AMM + LB V2.2), **Agni Finance** (V3), **Fluxion** (V3), **Aave V3**.

## Available Tools

47 tools total. Every tool is callable as `mantle_<name>` from an AI agent or via `mantle-cli` on the command line.

### Read Tools

#### Chain & Network

| Tool | Purpose |
|------|---------|
| `mantle_getChainInfo` | Static chain config: chain ID, WMNT address, RPC URLs |
| `mantle_getChainStatus` | Live chain status: block number, gas price |
| `mantle_getTransactionReceipt` | Fetch tx receipt: status, gas used, from/to |
| `mantle_estimateGas` | Estimate gas cost for an unsigned tx |
| `mantle_getNonce` | Pending transaction count (nonce) for an address |

#### Account

| Tool | Purpose |
|------|---------|
| `mantle_getBalance` | Native MNT balance for a wallet |
| `mantle_getTokenBalances` | ERC-20 balances for multiple tokens |
| `mantle_getAllowances` | Check token approvals for a spender |

> **Portfolio note:** `mantle_getTokenBalances` only shows tokens held directly in the wallet. Assets deployed into DeFi must be fetched separately: `mantle_getV3Positions` (Agni/Fluxion LP), `mantle_getLBPositions` (Merchant Moe LB), `mantle_getAavePositions` (Aave collateral + debt).

#### Token

| Tool | Purpose |
|------|---------|
| `mantle_getTokenInfo` | Token metadata: name, symbol, decimals, totalSupply |
| `mantle_getTokenPrices` | USD prices (DexScreener + DefiLlama) |
| `mantle_resolveToken` | Resolve symbol → address + decimals |

#### Registry

| Tool | Purpose |
|------|---------|
| `mantle_resolveAddress` | Look up a contract by name/alias in the verified registry |
| `mantle_validateAddress` | Check if an address is a contract, EOA, or undeployed |

#### DEX / Swap

| Tool | Purpose |
|------|---------|
| `mantle_getSwapQuote` | Swap price quote across Agni, Fluxion, Merchant Moe; returns `minimum_out_raw` for slippage protection |
| `mantle_getSwapPairs` | List known trading pairs and fee tiers for a DEX |
| `mantle_getPoolLiquidity` | Pool reserves and total TVL for a specific pool |
| `mantle_getPoolOpportunities` | Scan and rank candidate pools for a token pair |
| `mantle_getProtocolTvl` | Protocol-level TVL (Agni, Merchant Moe, or all) |

#### LP Positions

| Tool | Purpose |
|------|---------|
| `mantle_getV3PoolState` | On-chain state of an Agni/Fluxion V3 pool: tick, sqrtPrice, liquidity |
| `mantle_getV3Positions` | Wallet's Agni/Fluxion LP positions with uncollected fees |
| `mantle_getLBPairState` | Merchant Moe LB pair state: active bin, reserves, nearby bins |
| `mantle_getLBPositions` | Wallet's Merchant Moe LB positions by bin |
| `mantle_findPools` | Discover all pools for a pair across DEXes (TVL, volume, fee APR, recommendation) |
| `mantle_analyzePool` | Deep pool analysis: fee APR, risk score, investment projections |
| `mantle_suggestTickRange` | Suggest V3 tick ranges (wide/moderate/tight) for an LP position |

#### Lending (Aave V3)

| Tool | Purpose |
|------|---------|
| `mantle_getLendingMarkets` | Market data: supply APY, borrow APY, TVL, LTV, liquidation threshold |
| `mantle_getAavePositions` | Wallet's Aave positions: collateral, debt, health factor |

#### Indexer

| Tool | Purpose |
|------|---------|
| `mantle_querySubgraph` | GraphQL query against a Mantle subgraph endpoint |
| `mantle_queryIndexerSql` | Read-only SQL query against an indexer endpoint |

#### Diagnostics

| Tool | Purpose |
|------|---------|
| `mantle_checkRpcHealth` | RPC endpoint reachability, chain ID, latency |
| `mantle_probeEndpoint` | Send an arbitrary allowed RPC call to probe an endpoint |

#### Utilities

| Tool | Purpose |
|------|---------|
| `mantle_parseUnits` | Convert a decimal amount to raw integer (e.g. "1.5 USDC" → `1500000`) |
| `mantle_formatUnits` | Convert a raw integer to decimal string |
| `mantle_encodeCall` | ABI-encode a contract function call to produce calldata hex |

### Write Tools (build unsigned transactions)

Every write tool returns an `unsigned_tx` object with `{ to, data, value, chainId }`. The caller signs and broadcasts externally — these tools never hold keys.

#### Token Operations

| Tool | Purpose | Protocols |
|------|---------|-----------|
| `mantle_buildApprove` | ERC-20 approve (whitelist-enforced spender) | Any whitelisted contract |
| `mantle_buildWrapMnt` | Wrap MNT → WMNT | WMNT |
| `mantle_buildUnwrapMnt` | Unwrap WMNT → MNT | WMNT |

#### Swap

| Tool | Purpose | Protocols |
|------|---------|-----------|
| `mantle_buildSwap` | Swap tokens — requires `amount_out_min` from a prior `mantle_getSwapQuote` call | Agni, Fluxion, Merchant Moe |

#### Liquidity Provision

| Tool | Purpose | Protocols |
|------|---------|-----------|
| `mantle_buildAddLiquidity` | Add LP position (supports USD amount + range presets) | Agni, Fluxion, Merchant Moe |
| `mantle_buildRemoveLiquidity` | Remove LP position (percentage mode for V3) | Agni, Fluxion, Merchant Moe |
| `mantle_buildCollectFees` | Collect accrued fees from a V3 LP position | Agni, Fluxion |

#### Aave V3

| Tool | Purpose |
|------|---------|
| `mantle_buildAaveSupply` | Deposit collateral into Aave V3 |
| `mantle_buildAaveBorrow` | Borrow from Aave V3 |
| `mantle_buildAaveRepay` | Repay Aave V3 debt (pass `max` for full repayment) |
| `mantle_buildAaveWithdraw` | Withdraw from Aave V3 |
| `mantle_buildAaveSetCollateral` | Enable or disable an asset as Aave V3 collateral |

#### Advanced

| Tool | Purpose |
|------|---------|
| `mantle_buildRawTx` | Wrap arbitrary ABI-encoded calldata into an unsigned tx payload |

## DeFi Workflow

The standard execution flow for any DeFi operation:

```
1. READ   — Check balances, get quotes, check allowances
2. BUILD  — Call mantle_build* to get unsigned_tx
3. SHOW   — Present human_summary to user for confirmation
4. SIGN   — Sign and broadcast the unsigned_tx externally
5. WAIT   — Wait for tx confirmation before next step
6. REPEAT — Continue with next operation in the sequence
```

### Example: Swap 10 MNT → USDC on Agni

```
Step 1: mantle_buildWrapMnt({ amount: "10" })
        → sign & broadcast → 10 WMNT

Step 2: mantle_getSwapQuote({ provider: "agni", token_in: "WMNT", token_out: "USDC", amount_in: "10" })
        → estimated: ~8.5 USDC

Step 3: mantle_buildApprove({ token: "WMNT", spender: "0x319B69888b0d11cEC22caA5034e25FfFBDc88421", amount: "10" })
        → sign & broadcast

Step 4: mantle_buildSwap({ provider: "agni", token_in: "WMNT", token_out: "USDC", amount_in: "10", recipient: "0xYOUR_WALLET", fee_tier: 3000 })
        → sign & broadcast → receive USDC
```

### Example: Add WMNT-USDe LP on Merchant Moe

```
Step 1: Wrap MNT → WMNT (mantle_buildWrapMnt)
Step 2: Swap half WMNT → USDe (mantle_buildSwap, provider: "merchant_moe")
Step 3: Approve WMNT for LB Router (mantle_buildApprove, spender: "0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a")
Step 4: Approve USDe for LB Router (mantle_buildApprove)
Step 5: Add liquidity (mantle_buildAddLiquidity, provider: "merchant_moe")
```

## Whitelisted Contracts

Write tools enforce a whitelist. Only these contracts can be used as `spender` in approve or as swap/LP targets:

| Protocol | Contract | Address |
|----------|----------|---------|
| Merchant Moe | MoeRouter | `0xeaEE7EE68874218c3558b40063c42B82D3E7232a` |
| Merchant Moe | LB Router V2.2 | `0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a` |
| Agni | SwapRouter | `0x319B69888b0d11cEC22caA5034e25FfFBDc88421` |
| Agni | PositionManager | `0x218bf598D1453383e2F4AA7b14fFB9BfB102D637` |
| Fluxion | SwapRouter | `0x5628a59df0ecac3f3171f877a94beb26ba6dfaa0` |
| Fluxion | PositionManager | `0x2b70c4e7ca8e920435a5db191e066e9e3afd8db3` |
| Aave V3 | Pool | `0x458F293454fE0d67EC0655f3672301301DD51422` |
| Aave V3 | WETHGateway | `0x9C6cCAC66b1c9AbA4855e2dD284b9e16e41E06eA` |
| WMNT | WMNT | `0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8` |

## Safety Rules

1. **Never hold private keys** — all `mantle_build*` tools return unsigned payloads only
2. **Verify addresses first** — use `mantle_resolveAddress` / `mantle_resolveToken` before building transactions
3. **Get a quote before swapping** — call `mantle_getSwapQuote` to know expected output and set slippage protection
4. **Show `human_summary`** — every build tool returns a human-readable summary; present it to the user before signing
5. **MNT is the gas token** — not ETH; all gas estimates are in MNT
6. **Never fabricate calldata** — always use the build tools; do not construct transaction data manually
7. **One tx at a time** — sign and wait for confirmation before building the next tx in a sequence

## Skills

The `skills/` directory contains the `mantle-openclaw-competition` skill — a domain-specific workflow guide for AI agents participating in the OpenClaw asset accumulation competition on Mantle.

| Skill | Purpose |
|-------|---------|
| `mantle-openclaw-competition` | End-to-end DeFi operations guide: swap, LP, Aave V3 lending, portfolio reads — whitelist-enforced |

The skill definition lives at `skills/mantle-openclaw-competition/SKILL.md`.

## Local Development

```bash
npm install
npm run build
```

Verify:

```bash
npm test
```

## CLI

The `mantle-cli` command exposes every tool as a subcommand. All commands support `--json` for machine-readable output and `--network sepolia` for testnet.

```bash
# Chain
mantle-cli chain info --json
mantle-cli chain status --json
mantle-cli chain tx --hash <tx_hash> --json
mantle-cli chain estimate-gas --to <address> --data <hex> --json

# Account
mantle-cli account balance <address> --json
mantle-cli account token-balances <address> --tokens USDC,WMNT --json
mantle-cli account allowances <owner> --pairs USDC:0x319B... --json

# Token
mantle-cli token info USDC --json
mantle-cli token prices --tokens WMNT,USDC --json
mantle-cli token resolve mETH --json

# Registry
mantle-cli registry resolve agni_router --json
mantle-cli registry validate <address> --json

# DEX
mantle-cli defi swap-quote --in WMNT --out USDC --amount 10 --provider best --json
mantle-cli defi pool-opportunities --token-a WMNT --token-b USDC --json
mantle-cli defi pool-liquidity <pool_address> --json
mantle-cli defi tvl --json
mantle-cli defi analyze-pool --token-a WMNT --token-b USDC --fee-tier 3000 --provider agni --json

# LP
mantle-cli lp find-pools --token-a USDC --token-b USDe --json
mantle-cli lp pool-state --token-a WMNT --token-b USDC --fee-tier 3000 --provider agni --json
mantle-cli lp positions --owner <address> --json
mantle-cli lp lb-positions --owner <address> --json
mantle-cli lp suggest-ticks --token-a WMNT --token-b USDC --fee-tier 3000 --provider agni --json

# Aave
mantle-cli aave markets --json
mantle-cli aave positions --user <address> --json

# Write (all output unsigned_tx JSON)
mantle-cli swap wrap-mnt --amount 10 --json
mantle-cli swap unwrap-mnt --amount 10 --json
mantle-cli approve --token WMNT --spender 0x319B... --amount 10 --json
mantle-cli swap build-swap --provider agni --in WMNT --out USDC --amount 10 --recipient <addr> --amount-out-min <raw> --json
mantle-cli lp add --provider agni --token-a WMNT --token-b USDC --amount-usd 1000 --range-preset moderate --recipient <addr> --json
mantle-cli lp remove --provider agni --token-id <id> --percentage 100 --recipient <addr> --json
mantle-cli lp collect-fees --provider agni --token-id <id> --recipient <addr> --json
mantle-cli aave supply --asset USDC --amount 100 --on-behalf-of <addr> --json
mantle-cli aave borrow --asset USDC --amount 50 --on-behalf-of <addr> --json
mantle-cli aave repay --asset USDC --amount max --on-behalf-of <addr> --json
mantle-cli aave withdraw --asset USDC --amount max --to <addr> --json
mantle-cli aave set-collateral --asset WMNT --json

# Tool discovery
mantle-cli catalog list --json
mantle-cli catalog search --tag swap --json
```

## Packages

This monorepo produces two independently publishable packages:

| Package | Description |
|---------|-------------|
| [`@mantleio/mantle-core`](packages/core/README.md) | Shared business logic — tools, config, and chain interaction |
| [`@mantleio/mantle-cli`](packages/cli/README.md) | CLI for chain reads, DeFi queries, and transaction building |
