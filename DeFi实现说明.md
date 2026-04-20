# DeFi 操作实现说明（DEX Swap / Add·Remove Liquidity / AAVE）

本文件聚焦 **从外到内** 的调用链，说明 `mantle-agent-cli` 目前在代码层面是如何实现 DEX（Agni / Fluxion / Merchant Moe）的 `swap / addLiquidity / removeLiquidity`，以及 Aave V3 上全部操作的。所有写类操作都遵循同一个设计原则：

> **只构造"不带签名的交易" (`unsigned_tx`)，不保存任何私钥、不签名、不广播。** 签名和广播由外部签名器（Privy 等）完成。

## 0. 统一调用分层

所有写类命令的调用路径都是同一套：

```
终端用户 / Agent
   │
   ▼
CLI 层  (packages/cli/src/commands/*.ts)
   │   解析 flag → 传入统一的 args 对象
   ▼
Tool 层 (packages/core/src/tools/index.ts 中的 allTools[name])
   │   每个工具都是 wrapBuildHandler(builder) 包装过的 handler
   ▼
Builder 层 (packages/core/src/tools/defi-write.ts 里的 buildSwap / buildAddLiquidity / …)
   │   只做"业务构造"：参数校验、白名单校验、路由/池子发现、encodeFunctionData
   ▼
viem 编码 + RPC 读
   │   - encodeFunctionData(ABI, functionName, args) → calldata
   │   - readContract / multicall → 池子状态、余额、allowance 等
   ▼
wrapBuildHandler 补齐链上动态字段（gas / EIP-1559 fee / pending nonce / idempotency_key）
   │
   ▼
返回 { unsigned_tx, signable_tx, warnings, pool_params, aave_reserve, idempotency_key, ... }
```

### 0.1 CLI → Tool

以 `mantle-cli swap build-swap` 为例 (`packages/cli/src/commands/defi-swap.ts`)：

```26:106:packages/cli/src/commands/defi-swap.ts
  group
    .command("build-swap")
    ...
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const amountOutMinRaw = opts.minimumOut ?? opts.amountOutMin;
      const result = await allTools["mantle_buildSwap"].handler({
        provider: opts.provider,
        token_in: opts.in,
        token_out: opts.out,
        amount_in: String(opts.amount),
        recipient: opts.recipient,
        amount_out_min: amountOutMinRaw ? String(amountOutMinRaw) : undefined,
        slippage_bps: opts.slippageBps,
        fee_tier: opts.feeTier,
        bin_step: opts.binStep,
        ...
        owner: opts.owner,
        network: globals.network
      });
      ...
    });
```

CLI 本身只是把 commander 的 flag 映射成统一的 JSON 对象，然后调用 `allTools["mantle_buildSwap"].handler(args)`。LP / Aave 的 CLI 命令结构完全一致（`defi-lp.ts`、`defi-aave.ts`），只不过调用的工具名不同。

### 0.2 Tool = wrapBuildHandler(builder)

`packages/core/src/tools/defi-write.ts` 中所有对外导出的工具都长这样：

```5099:5145:packages/core/src/tools/defi-write.ts
  mantle_buildApprove: {
    name: "mantle_buildApprove",
    description: "...",
    inputSchema: { ... },
    handler: wrapBuildHandler(buildApprove)
  },
  ...
```

`wrapBuildHandler` 的职责（见 `defi-write.ts` L709–L1150）：

1. 先调用 **真正的 builder**（如 `buildSwap / buildAaveSupply`），拿到一个半成品：
   ```ts
   { intent, human_summary, unsigned_tx: { to, data, value, chainId }, warnings, ... }
   ```
2. 判定 `intent` 是否是 `*_skip`（如 `approve_skip`）。如果是：短路，打上 `is_broadcastable: false`，计算 idempotency_key，直接返回——避免把"无需上链"的结果填上 nonce/gas 导致签名器误广播 0-value 空交易。
3. 否则从 args 里抽取 `sender / owner / on_behalf_of` 当作签名者；缺这三个里的任一一个 → 抛 `MISSING_SIGNER`。
4. 并发执行 **4 个 RPC 调用**：
   - `estimateGas({ to, data, value, account: sender })` —— 仿真调用，若 revert 则返回 `GAS_ESTIMATION_FAILED` 并附带 `revert_selector / revert_message`（通过 `revert-decoder.ts` 自定义错误解码）。
   - `getBlock("latest")` —— 取 `baseFeePerGas` 做 EIP-1559 定价：`maxFeePerGas = baseFee × 2 + tip`。
   - `estimateMaxPriorityFeePerGas()` —— 取 priority tip，低于 0.001 Gwei 则抬到最小值。
   - `getTransactionCount(sender, "pending")` —— 取 pending nonce；失败独立抛 `NONCE_FETCH_FAILED`。
5. 往 `unsigned_tx` 上填 `gas`（原估算 × 1.2 buffer）、`maxFeePerGas`、`maxPriorityFeePerGas`、`nonce`。
6. 生成 `signable_tx`（给 Privy 等签名器直接用的 `0x`-hex QUANTITY 版本）。
7. 计算 `idempotency_key = keccak256(sender || request_id || to || data || value || chainId || nonce)` 用于外部执行器去重。
8. 最终返回 `{ is_broadcastable: true, unsigned_tx, signable_tx, idempotency_key, idempotency_scope, warnings, ... }`。

> 换言之：`builder` 只负责"业务逻辑 + calldata 构造"，`wrapBuildHandler` 负责"让交易可直接签名广播"。本文接下来讲的每个操作，**都在 step 2 之前的 builder 里发生**。

### 0.3 白名单、token 解析、RPC client

`defi-write.ts` 里三个共用基础：

- `getContractAddress(provider, key, network)` —— 从 `packages/core/src/config/protocols.ts` 查路由器/PositionManager/Factory 地址。所有 `unsigned_tx.to` 都来自这里。
- `isWhitelistedContract(address, network)` —— `buildApprove` 和 `buildSetLBApprovalForAll` 会拒绝不在白名单里的 spender。
- `resolveToken(d, input, network)` —— 走 `token-registry.ts`，把符号（"WMNT"/"USDC"）或地址解析为 `{ address, symbol, decimals }`。
- `getPublicClient(network)` / 依赖注入的 `d.getClient(network)` —— 返回 viem 的 `PublicClient`，所有 `readContract` / `multicall` / `estimateGas` 都走它。

---

## 1. DEX Swap

CLI：`mantle-cli swap build-swap --provider <agni|fluxion|merchant_moe> --in <token> --out <token> --amount <n> --recipient <addr> --owner <addr> [--minimum-out <n>]`

Tool：`mantle_buildSwap` → `buildSwap()` （`defi-write.ts` L2018–L2367）

### 1.1 参数校验与预检

```2018:2156:packages/core/src/tools/defi-write.ts
export async function buildSwap(args, deps?) {
  const { network } = normalizeNetwork(args);
  const provider = requireProvider(args.provider);
  const tokenIn = await resolveToken(d, tokenInInput, network);
  const tokenOut = await resolveToken(d, tokenOutInput, network);
  ...
  // xStocks RWA 只能走 Fluxion
  if (xStockToken && provider !== "fluxion") {
    throw new MantleMcpError("XSTOCKS_FLUXION_ONLY", ...);
  }
  ...
  // 强制要求 amount_out_min，防止 0 滑点保护（除非 allow_zero_min=true）
  if (!args.amount_out_min) throw MISSING_SLIPPAGE_PROTECTION;
  ...
  // ── 阻塞式 allowance 预检 ──
  // 若传了 owner，用 ERC-20.allowance(owner, router) 预读；不足时直接 INSUFFICIENT_ALLOWANCE，
  // 避免签名器广播一笔注定 revert(STF) 的交易。
  const allowance = await client.readContract({
    address: tokenIn.address, abi: ERC20_ABI,
    functionName: "allowance",
    args: [swapOwner, routerAddress]
  });
  if (allowance < amountInRaw) throw INSUFFICIENT_ALLOWANCE;
```

要点：
- `parseAmountOutMin` 同时兼容"raw 整数"和"decimal 字符串"两种形态（方便把 `getSwapQuote` 返回的 `minimum_out_raw` 直接粘进来）。
- 若提供了 `quote_fee_tier / quote_bin_step / quote_provider`，会与重新发现出来的 fee_tier / bin_step 交叉校验，不一致直接 `QUOTE_BUILD_MISMATCH` 阻断，避免"用旧池子的报价去最新池子做滑点保护"。

### 1.2 Agni / Fluxion（Uniswap V3 风格）

```2157:2256:packages/core/src/tools/defi-write.ts
if (provider === "agni" || provider === "fluxion") {
  let feeTier: number | undefined;
  if (typeof args.fee_tier === "number") {
    feeTier = args.fee_tier;           // 用户指定
  } else {
    const bestPool = await discoverBestV3Pool(provider, tokenIn, tokenOut, network, d);
    if (bestPool) feeTier = bestPool.feeTier;   // 查工厂 → 链上流动性最高的 fee tier
  }

  if (feeTier !== undefined) {
    // 直接单跳
    return buildV3Swap({ ..., feeTier });
  }

  // 否则 2 跳 via bridge token
  const route = await findV3Route(provider, tokenIn, tokenOut, network, d);
  if (route) return buildV3MultihopSwap({ ..., route });
  throw NO_ROUTE_FOUND;
}
```

- **池子发现**：`discoverBestV3Pool()`（`pool-discovery.ts` 的共享版）批量调 `Factory.getPool(tokenA, tokenB, feeTier)`（常见 tier: 100 / 500 / 2500 / 3000 / 10000），再对每个命中池读 `liquidity()`，挑流动性最大的。
- **多跳发现**：`findV3Route()` 遍历 `BRIDGE_TOKEN_ADDRESSES`（`WMNT / USDC / USDT0 / USDT / USDe / WETH`），每个 bridge 两边各发现一次池子，取"两腿流动性中的较小值"作为评分，最大者胜出。

**单跳 calldata**（`buildV3Swap`，L2369–L2448）：

```2402:2417:packages/core/src/tools/defi-write.ts
const data = encodeFunctionData({
  abi: V3_SWAP_ROUTER_ABI,
  functionName: "exactInputSingle",
  args: [{
    tokenIn, tokenOut, fee: feeTier, recipient, deadline,
    amountIn: amountInRaw, amountOutMinimum: amountOutMin,
    sqrtPriceLimitX96: 0n
  }]
});
// unsigned_tx.to = swap_router (Agni 0x319B... / Fluxion 0x5628...)
```

**多跳 calldata**（`buildV3MultihopSwap`，L2537–L2606）：

```2556:2574:packages/core/src/tools/defi-write.ts
const path = encodeV3Path(route.tokens.map(t => t.address), route.fees);
// V3 packed path：token(20B) + fee(3B) + token(20B) + fee(3B) + token(20B)
const data = encodeFunctionData({
  abi: V3_SWAP_ROUTER_ABI,
  functionName: "exactInput",
  args: [{ path, recipient, deadline, amountIn: amountInRaw, amountOutMinimum: amountOutMin }]
});
```

### 1.3 Merchant Moe（Liquidity Book V2.2）

Merchant Moe 是 Trader Joe 系的 LB AMM（bin-based），**没有 fee tier 概念，使用 `bin_step`**。

```2261:2367:packages/core/src/tools/defi-write.ts
// 显式 bin_step 模式：查 LB Factory，若返回非空 pair 则 routerVersion = 3 (V2.2)
if (typeof args.bin_step === "number") {
  const pairInfo = await client.readContract({
    address: factoryAddr, abi: LB_FACTORY_ABI,
    functionName: "getLBPairInformation",
    args: [tokenIn.address, tokenOut.address, BigInt(args.bin_step)]
  });
  if (pairInfo.LBPair !== ZERO) routerVersion = 3;
  return buildMoeSwap({ ..., binStep, routerVersion });
}

// 否则用 LB Quoter 做完整路径发现（直连 + 2-hop 都试一遍）
const moeQuoterRoute = await discoverMoeRouteViaQuoter(tokenIn, tokenOut, amountInRaw, network, d);
if (moeQuoterRoute) return buildMoeMultihopSwapFromQuoter({ ..., quoterRoute });
throw NO_ROUTE_FOUND;
```

**LB Quoter 路径发现**（`discoverMoeRouteViaQuoter`，L1869–L1936）：
- 构造候选路径：直连 `[in, out]` + 6 条 bridge 两跳。
- 并发调 `LB Quoter.findBestPathFromAmountIn(path, amountIn)`（viem `readContract`），quoter 内部会自动选最优 bin_step。
- 挑 `amounts[last]` 最大的一条作为最佳路径。

**单跳 calldata**（`buildMoeSwap`，L2450–L2531）：

```2486:2500:packages/core/src/tools/defi-write.ts
const path = {
  pairBinSteps: [BigInt(binStep)],
  versions: [routerVersion],    // 0=V1, 3=V2.2
  tokenPath: [tokenIn.address, tokenOut.address]
};
const data = encodeFunctionData({
  abi: LB_ROUTER_ABI,
  functionName: "swapExactTokensForTokens",
  args: [amountInRaw, amountOutMin, path, recipient, deadline]
});
// unsigned_tx.to = lb_router_v2_2 (0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a)
```

**多跳 calldata**（`buildMoeMultihopSwapFromQuoter`，L1941–L2012）：直接使用 quoter 返回的 `(tokenPath, binSteps, versions)` 构建同一个 `swapExactTokensForTokens` 调用，只是 `path.tokenPath` 和 `pairBinSteps` 长度 > 2。

### 1.4 Swap 总结

| 提供方 | 入口合约 | 核心 ABI 方法 | 路由发现机制 |
| --- | --- | --- | --- |
| Agni | `swap_router` 0x319B… | `exactInputSingle` / `exactInput` | 枚举 fee tier 查 Factory → 挑流动性最大 + bridge-token 2 跳 |
| Fluxion | `swap_router` 0x5628… | 同上 | 同上 |
| Merchant Moe | `lb_router_v2_2` 0x013e… | `swapExactTokensForTokens`（带 `(binSteps, versions, tokenPath)` 元组） | LB Factory 校验 + LB Quoter `findBestPathFromAmountIn` |

---

## 2. DEX Add Liquidity

CLI：`mantle-cli lp add --provider <...> --token-a --token-b (--amount-a --amount-b | --amount-usd) --recipient --owner [...]`

Tool：`mantle_buildAddLiquidity` → `buildAddLiquidity()` (`defi-write.ts` L2612–L3093)

### 2.1 公共前处理

`buildAddLiquidity` 一开始做三件大事：

1. **Range preset 预解析**（L2636–L2722）
   V3 下如果传了 `range_preset: aggressive/moderate/conservative`，走：
   - `Factory.getPool(tokenA, tokenB, feeTier)` 找池子。
   - `pool.slot0()` + `pool.tickSpacing()` 读当前 tick 和 tick 间隔。
   - 用 `log(1 + x%) / log(1.0001)` 把 ±5/10/20% 换成 tick 偏移，再按 `tickSpacing` 取整。
   - 结果对 `[-887272, 887272]` 做 clamp，异常时回退 full range。
   - 池子地址 **复用** 到步骤 2 的 USD 模式，避免重复 RPC。

2. **USD 金额模式**（L2731–L2875）
   若传 `amount_usd`：
   - `fetchTokenPriceUsd()` —— 从 CoinGecko → DexScreener → DefiLlama 级联拿价，并做 3% / 15% 收敛检查（`PRICE_AGREE_PCT`），分歧超过阈值降置信度但不 block。
   - V3 下再读一次 `slot0()` → `sqrtPriceX96`，用 V3 数学求 `{amount0Frac, amount1Frac}` 来决定 USD 在两个 token 间的分配比例（池外 / 池内 / 池上不同公式）。
   - Merchant Moe / full-range 走 50/50 fallback。
   - 最后用 `parseUnits(decimalA.toFixed(decimalsA), decimalsA)` 变成原始整数 amount。

3. **Allowance 阻塞预检**（L2947–L3001）
   对 `token_a` / `token_b` 并发读 `allowance(owner, spender)`，其中 spender 为：
   - V3：`position_manager`
   - Moe：`lb_router_v2_2`

   任一不足立刻抛 `INSUFFICIENT_ALLOWANCE`。

### 2.2 Agni / Fluxion V3：mint NFT 头寸

`buildV3AddLiquidity`（L3095–L3311）的核心是"**池态感知的 amountMin 计算**"——这是跟标准 Uniswap V3 集成最容易踩坑的地方。

```3164:3262:packages/core/src/tools/defi-write.ts
// 1. 用 token0 < token1 排序
// 2. 查 Factory.getPool → 得 poolAddr
// 3. 并发读 pool.slot0() (sqrtPriceX96, currentTick) + pool.tickSpacing()
// 4. V3 float 数学算出"以 1 单位流动性 L 进入 [tickLower, tickUpper] 的池子，在当前 price 下会消耗多少 amount0/amount1"
//    sqrtP       = sqrtPriceX96 / 2^96
//    sqrtPLower  = 1.0001^(tickLower/2)
//    sqrtPUpper  = 1.0001^(tickUpper/2)
//    sqrtPClamp  = clamp(sqrtP, sqrtPLower, sqrtPUpper)
//    perL0       = 1/sqrtPClamp - 1/sqrtPUpper    // 下界/区间内公式
//    perL1       = sqrtPClamp - sqrtPLower
// 5. L = min(amount0Desired/perL0, amount1Desired/perL1)   // 实际被池子吸收的流动性
// 6. 推回 expAmount0 = floor(L * perL0), expAmount1 = floor(L * perL1)
// 7. amountMin = expAmount * (10000 - slippageBps) / 10000   // 而不是 desired * slippage
```

为什么这么搞？V3 的 `mint()` 会按当前价拉取"两边都够用的最小 L"并退还多出来的那一侧。如果你用 `desired * (1 - slippage)` 当 `amountMin`，稍微不平衡就会让"少的那一边"也过 slippage 检查，于是交易以 "Price slippage check" revert。这里改成按"池子实际会拉走的量"反推 min，不平衡输入也能过检查，多余的钱留在钱包里（并 warning 提示）。

**实际的 calldata**（L3279–L3297）：

```ts
encodeFunctionData({
  abi: V3_POSITION_MANAGER_ABI,
  functionName: "mint",
  args: [{
    token0, token1, fee: feeTier,
    tickLower, tickUpper,
    amount0Desired, amount1Desired,
    amount0Min, amount1Min,    // 按池态反推
    recipient, deadline
  }]
});
// unsigned_tx.to = position_manager
```

### 2.3 Merchant Moe LB：bin 分布 + activeId

`buildMoeAddLiquidity`（L3313–L3570）步骤：

1. **解析 LBPair 和 canonical tokenX**
   ```ts
   LB_FACTORY.getLBPairInformation(tokenA, tokenB, binStep) → { LBPair, binStep, ... }
   LBPair.getActiveId() → current active bin id
   LBPair.getTokenX()   → pair 规定的"X 币"
   ```
   同时会按 `tokenX` 地址对 (tokenA, tokenB) 排序成 (tokenX, tokenY) —— LB Router 一旦顺序错了就 `LBRouter__WrongTokenOrder` revert。

2. **解析 bins 和 distribution**（L3422–L3531）
   用户可以：
   - 同时给 `delta_ids + distribution_x + distribution_y`（严格校验三者同长度，每个 distribution 之和 ≈ 1e18）。
   - 只给 `delta_ids`（或 `range_preset`），代码自动生成"uniform spot"分布：
     - `delta ≥ 0` 的 bin 放 tokenX；`delta ≤ 0` 的 bin 放 tokenY；`delta == 0` 两边都有。
     - 每个 bin 拿 `1e18 / numBins`，余数塞进 active bin。
   - 什么都不给，默认 ±3 bins 均匀分布。

3. **calldata**（L3534–L3556）：

   ```ts
   encodeFunctionData({
     abi: LB_ROUTER_ABI,
     functionName: "addLiquidity",
     args: [{
       tokenX, tokenY, binStep,
       amountX, amountY,
       amountXMin, amountYMin,               // desired × (1 - slippageBps/10000)
       activeIdDesired, idSlippage,          // 抗 active-bin 漂移
       deltaIds, distributionX, distributionY,
       to: recipient, refundTo: recipient,
       deadline
     }]
   });
   // unsigned_tx.to = lb_router_v2_2
   ```

---

## 3. DEX Remove Liquidity

CLI：`mantle-cli lp remove --provider <...> --recipient --owner [V3: --token-id --percentage|--liquidity] [Moe: --token-a --token-b --percentage|--ids --amounts]`

Tool：`mantle_buildRemoveLiquidity` → `buildRemoveLiquidity()` (`defi-write.ts` L3576–L4014)

### 3.1 Agni / Fluxion V3：multicall(decreaseLiquidity + collect)

```3591:3682:packages/core/src/tools/defi-write.ts
if (provider === "agni" || provider === "fluxion") {
  const tokenId = BigInt(args.token_id);

  let liquidityToRemove: bigint;
  if (args.percentage != null) {
    // 读当前 liquidity → 按百分比切
    const position = await client.readContract({
      address: position_manager, abi: V3_POSITION_MANAGER_ABI,
      functionName: "positions", args: [tokenId]
    });
    const totalLiquidity = position[7];
    liquidityToRemove = totalLiquidity * round(pct * 100) / 10000;
  } else {
    liquidityToRemove = BigInt(args.liquidity);
  }

  return buildV3RemoveLiquidity({ ..., liquidity: liquidityToRemove });
}
```

`buildV3RemoveLiquidity`（L4018–L4097）把两步并成一个 **PositionManager.multicall**：

```4049:4080:packages/core/src/tools/defi-write.ts
const decreaseData = encodeFunctionData({
  abi: V3_POSITION_MANAGER_ABI,
  functionName: "decreaseLiquidity",
  args: [{ tokenId, liquidity, amount0Min: 0, amount1Min: 0, deadline }]
});
const collectData = encodeFunctionData({
  abi: V3_POSITION_MANAGER_ABI,
  functionName: "collect",
  args: [{ tokenId, recipient, amount0Max: UINT128_MAX, amount1Max: UINT128_MAX }]
});
const data = encodeFunctionData({
  abi: V3_POSITION_MANAGER_ABI,
  functionName: "multicall",
  args: [[decreaseData, collectData]]
});
// unsigned_tx.to = position_manager
```

即一次交易内：先把流动性烧掉（`decreaseLiquidity`），接着把烧出来的 token0/token1 + 累积手续费 `collect` 到 recipient。这也是 V3 的标准"撤 LP"习惯。

> 注意：这里 `amount0Min / amount1Min = 0`，带有 `"Consider setting minimum outputs to avoid MEV"` 警告。撤单在 V3 里并不重要做 min 保护，因为池内滑点一般影响有限。

### 3.2 Merchant Moe LB：自动扫描 + 按比例 burn

Moe 这条路径比 V3 复杂得多（L3684–L4013）：

1. **解析 LBPair 和 tokenX**（同 addLiquidity）。

2. **决定 ids + amounts**：
   - **`percentage` 模式**（推荐）：
     - 若用户传了 `ids`，就在这些 bin 上查余额。
     - 否则自动扫描 `[activeId - 25, activeId + 25]`。
     - 用 `client.multicall` 一次批量读 `LBPair.balanceOf(owner, binId)`。
     - 对每个 `balance > 0` 的 bin 按比例算 `amountToRemove = balance × pct×100 / 10000`。
     - 全部汇总出 `ids[] / amounts[]`。
   - **显式模式**：用户直接给 `ids` + `amounts`（每个 amount 是 `balance_raw` 整数，用 BigInt 解析防止超 2^53 精度丢失）。

3. **滑点保护**（L3900–L3941）：
   用 `multicall` 读每个 bin 的 `getBin(binId) → (reserveX, reserveY)` 和 `totalSupply(binId)`，按 pro-rata 估算撤出量：

   ```
   expectedX += reserveX × amounts[i] / totalSupply
   expectedY += reserveY × amounts[i] / totalSupply
   amountXMin = expectedX × (10000 - slippageBps) / 10000
   amountYMin = expectedY × (10000 - slippageBps) / 10000
   ```

4. **LB Operator 预授权检查**（L3965–L3994）：
   LB Token 是 ERC-1155 风格的 share，`router.removeLiquidity` 会调 `LBPair.burn(user, ...)`，而 `LBPair.burn` 的 `checkApproval` 要求 `isApprovedForAll(user, router) == true`。所以这里 best-effort 读 `LBPair.isApprovedForAll(recipient, router)`，若为 false 就在 warnings 里顶部插一条红色提示，告诉用户先跑 `lp approve-lb`。

5. **calldata**（L3945–L3959）：

   ```ts
   encodeFunctionData({
     abi: LB_ROUTER_ABI,
     functionName: "removeLiquidity",
     args: [tokenX, tokenY, binStep, amountXMin, amountYMin, ids, amounts, recipient, deadline]
   });
   // unsigned_tx.to = lb_router_v2_2
   ```

### 3.3 配套：`mantle_buildSetLBApprovalForAll`

因为 Moe 撤 LP 需要 operator 授权，`buildSetLBApprovalForAll`（L4109–L4256）单独存在：

- 校验 `operator` 必须在白名单里（防止把 LB share 批给陌生合约）。
- 如给了 `owner`，先读 `LBPair.isApprovedForAll(owner, operator)`，已是目标状态 → 返回 `approve_skip`（`wrapBuildHandler` 会短路掉）。
- 否则 `encodeFunctionData(LB_PAIR_ABI, "approveForAll", [operator, true|false])`；`unsigned_tx.to = pairAddress`。

### 3.4 配套：`mantle_buildCollectFees`（仅 V3）

`buildCollectFees`（L4944–L5092）：
- `positions(tokenId)` 读 `liquidity / tokensOwed0 / tokensOwed1`。
- 如果 `liquidity > 0n`，在 `collect` 之前先 `decreaseLiquidity(liquidity=0, ...)` 做一次 **"poke"**，把未结算的手续费推到 `tokensOwed0/1`。
- 最后都用 `PositionManager.multicall([ pokeData, collectData ])` 打包。
- 若 `liquidity == 0n`（位置已关闭），跳过 poke（不然 V3 会因 `require(params.liquidity > 0)` revert）。

---

## 4. Aave V3

五个写操作 + 一个 read：`buildAaveSupply` / `buildAaveBorrow` / `buildAaveRepay` / `buildAaveWithdraw` / `buildAaveSetCollateral`，加上只读的 `mantle_getAavePositions`（`defi-lending-read.ts`）。

共用地址：
- Pool：`0x458F293454fE0d67EC0655f3672301301DD51422`
- WETH Gateway：`0x9C6cCAC66b1c9AbA4855e2dD284b9e16e41E06eA`
- PoolDataProvider：`0x487c5c669D9eee6057C44973207101276cf73b68`

共用校验：所有入口都通过 `requireAaveReserve(assetInput)` 从 `aave-reserves.ts` 查到 `{ symbol, underlying, aToken, variableDebtToken, decimals, isolationMode, borrowableInIsolation, debtCeilingUsd, id }`。不在该表里的 token 直接拒掉（例如用户误把 `USDT` 当 `USDT0`）。

### 4.1 `buildAaveSupply`（L4262–L4338）

```ts
const data = encodeFunctionData({
  abi: AAVE_V3_POOL_ABI,
  functionName: "supply",
  args: [asset.address, amountRaw, onBehalfOf, 0 /* referralCode */]
});
// unsigned_tx.to = pool
```

额外行为：
- 提醒 `asset` 需要先对 Pool 做 approve。
- 如果 reserve 是 **Isolation Mode** 资产：
  - 加一条提示：能借的只有 `isolationBorrowableSymbols()`（典型：USDT0 / USDC）；且 collateral 可能没有自动开启，建议随后跑 `buildAaveSetCollateral` 校验。
  - 再加一条 `debtCeilingUsd` 和隔离模式条款提示。

### 4.2 `buildAaveBorrow`（L4344–L4505）

```ts
const data = encodeFunctionData({
  abi: AAVE_V3_POOL_ABI,
  functionName: "borrow",
  args: [asset.address, amountRaw, BigInt(interestRateMode), 0, onBehalfOf]
});
// interestRateMode: 2 = variable (默认), 1 = stable
```

两项重要**预检**：

1. **Isolation-Mode borrow 阻断**（L4395–L4456）
   如果要借的资产不属于 `borrowableInIsolation`，代码会：
   - 枚举所有 Aave reserve 的 `aToken.balanceOf(borrower)`（`Promise.all` 并发）。
   - 若借款人只持有 isolation-mode 资产的 aToken，而没有任何 non-isolation aToken → 直接抛 `ISOLATION_MODE_BORROW_BLOCKED`，阻止一笔必 revert 的借贷。

2. **健康因子预警**（L4461–L4483）
   `Pool.getUserAccountData(borrower)` 返回 `healthFactor (WAD=1e18)`。若 `< 2.0` 则 warning 提醒"这笔借款会进一步压低 HF，HF<1 会被清算"。

### 4.3 `buildAaveRepay`（L4511–L4575）

```ts
const amountRaw = args.amount === "max" ? MAX_UINT256 : requirePositiveAmount(...);
const data = encodeFunctionData({
  abi: AAVE_V3_POOL_ABI,
  functionName: "repay",
  args: [asset.address, amountRaw, BigInt(interestRateMode), onBehalfOf]
});
```

亮点：`"max"` 会翻译为 `type(uint256).max`，Pool 会自动取实际债务结清。需要先 approve underlying 给 Pool。

### 4.4 `buildAaveWithdraw`（L4581–L4640）

```ts
const amountRaw = args.amount === "max" ? MAX_UINT256 : requirePositiveAmount(...);
const data = encodeFunctionData({
  abi: AAVE_V3_POOL_ABI,
  functionName: "withdraw",
  args: [asset.address, amountRaw, to]
});
```

- `msg.sender` 必须是 aToken 持有者（Aave 规则），故这里 **强制要求 `owner`**（`requireAddress(args.owner ?? args.sender ?? args.on_behalf_of, "owner")`），由 `wrapBuildHandler` 拿去 pin nonce/gas。
- `to` 是"收钱地址"，可以跟 `owner` 不一样。
- warning 提醒撤抵押会降 HF。

### 4.5 `buildAaveSetCollateral`（L4679–L4891）

最复杂的一个——因为是"拨开关"，失败场景多，所以预检做得很重。

```ts
const data = encodeFunctionData({
  abi: AAVE_V3_POOL_ABI,
  functionName: "setUserUseReserveAsCollateral",
  args: [asset.address, useAsCollateral]
});
```

预检（一次 `multicall` 拉 3 个读）：

1. `aToken.balanceOf(user)` → 若为 0 → `NO_SUPPLY_BALANCE` 硬失败（没抵押物就谈不上开关）。
2. `Pool.getConfiguration(asset)` → 解码出 `ltvBps / active / frozen`：
   - `!active` → `RESERVE_NOT_ACTIVE`。
   - `useAsCollateral && ltvBps == 0` → `LTV_IS_ZERO`（Aave 治理把该资产 LTV 设成 0 的含义就是"不能作抵押"；这种情况拨开关无济于事，代码会直接告诉用户真正的根因）。
   - `frozen` → 只 warning。
3. `Pool.getUserConfiguration(user)` → 按 `reserve.id × 2 + 1` 位判定当前开关状态：
   - 若当前态 === 目标态 → warning 标记 `NO-OP`，`diagnosis = "already_in_desired_state"`。

无论上面如何，最终仍然返回一份可签的 `setUserUseReserveAsCollateral(asset, useAsCollateral)` 交易 + `diagnostics` 字段，让 agent 自己决定要不要签。

### 4.6 Aave 操作总结

| 操作 | ABI 方法 | 核心参数 | 关键预检 |
| --- | --- | --- | --- |
| supply | `Pool.supply` | `(asset, amount, onBehalfOf, 0)` | reserve 存在；Isolation 模式提示 |
| borrow | `Pool.borrow` | `(asset, amount, rateMode, 0, onBehalfOf)` | Isolation-mode borrow 硬拦；HF<2 warning |
| repay | `Pool.repay` | `(asset, amount\|MAX_UINT256, rateMode, onBehalfOf)` | 提醒 approve |
| withdraw | `Pool.withdraw` | `(asset, amount\|MAX_UINT256, to)` | 强制 `owner` 为 aToken 持有者 |
| setCollateral | `Pool.setUserUseReserveAsCollateral` | `(asset, true\|false)` | aToken>0、reserve active、LTV>0、当前态≠目标态 |

---

## 5. 安全与工程约束（横向）

以下机制贯穿所有写工具，是工程上最重要的"保命"设计：

1. **合约白名单**（`config/protocols.ts`）
   `isWhitelistedContract(address, network)` 限定 `unsigned_tx.to` 和 `approve` 的 spender 只能是固定那 20 个地址（Merchant Moe 7 + Agni 4 + Fluxion 5 + Aave 3 + WMNT 1）。任何不在表里的目标，不论用户怎么坚持都会被 `SPENDER_NOT_WHITELISTED` 拒掉。

2. **Token 白名单**（`config/tokens.ts` + `resolveToken`）
   所有 `token_in / token_out / token_a / token_b / asset` 都要先通过 `resolveToken()` 查注册表，拒掉 native zero-address、未识别符号等。

3. **滑点保护强制**
   `buildSwap` 强制要求 `amount_out_min`（非 allow_zero_min），同时支持 raw/decimal 两种形式；并跟前序 `getSwapQuote` 的 `fee_tier / bin_step / provider` 做交叉校验，任一不一致立即抛 `QUOTE_BUILD_MISMATCH`。

4. **allowance 阻塞预检**
   `buildSwap` / `buildAddLiquidity` / 以及 Moe 的 `buildRemoveLiquidity`（检查 LB operator）都会在 RPC 层面读一次 allowance；不足直接抛 `INSUFFICIENT_ALLOWANCE`，并附上可执行的 `mantle_buildApprove(...)` 指令，避免签名器把"注定 revert 的交易"广播出去。

5. **池态感知的 amountMin**（V3 mint 专属）
   `buildV3AddLiquidity` 用 `sqrtPriceX96 + ticks` 算实际会被吸收的 `amount0 / amount1`，在此基础上 × (1 - slippageBps)。这样即使传入 (amount_a, amount_b) 跟池子比例不匹配，也能过 V3 的 "Price slippage check"，多余的 token 自然留在钱包里。

6. **Isolation / LTV / Frozen 等 Aave 治理态**
   Aave 的业务语义很"非线性"（LTV=0 资产、隔离模式、冻结 reserve…），builder 会在构造交易前就做 RPC 预检，转换为工程化的错误码，不会把用户扔给链上 revert。

7. **确定性 unsigned_tx**
   `wrapBuildHandler` 只返回"完全 pin 死"的交易：`gas`（估算×1.2）、`maxFeePerGas = baseFee×2 + tip`、`maxPriorityFeePerGas`（地板 0.001 Gwei）、`nonce`（eth_getTransactionCount "pending"）都由它填，签名器拿到就能直接签，不能再改字段——避免 Privy 等签名器"自动分配 nonce"造成重复广播。

8. **Idempotency key**
   `keccak256(sender || request_id || to || data || value || chainId || nonce)`。同一个 `(sender, request_id)` 重建出同样的 unsigned_tx 会得到同样的 key；外部执行器可以此安全去重。Nonce 变化则自动产生新 key（nonce 推进后的合法重试不会被误去重）。

9. **Signable_tx**
   跟 `unsigned_tx` 字段一一对应，但 `chainId / nonce` 编码为 `0x`-hex QUANTITY、`from` 填 EIP-55 checksum，直接喂给 Privy `sign evm-transaction` 等 EIP-1193 签名器不用再做格式转换——这是前期 V3 benchmark 里反复重试的坑点专门治理。

---

## 6. 文件索引

| 功能 | CLI | Tool 名 | Builder 函数 | 大致行号 |
| --- | --- | --- | --- | --- |
| ERC-20 approve | `mantle-cli approve` | `mantle_buildApprove` | `buildApprove` | `defi-write.ts` L1464 |
| wrap / unwrap MNT | `swap wrap-mnt` / `unwrap-mnt` | `mantle_buildWrapMnt` / `…UnwrapMnt` | `buildWrapMnt` / `buildUnwrapMnt` | L1650 / L1688 |
| DEX Swap | `swap build-swap` | `mantle_buildSwap` | `buildSwap` + `buildV3Swap` / `buildMoeSwap` / multi-hop | L2018, L2369, L2450, L2537, L1941 |
| Add Liquidity | `lp add` | `mantle_buildAddLiquidity` | `buildAddLiquidity` + `buildV3AddLiquidity` / `buildMoeAddLiquidity` | L2612, L3095, L3313 |
| Remove Liquidity | `lp remove` | `mantle_buildRemoveLiquidity` | `buildRemoveLiquidity` + `buildV3RemoveLiquidity` | L3576, L4018 |
| LB operator 授权 | `lp approve-lb` | `mantle_buildSetLBApprovalForAll` | `buildSetLBApprovalForAll` | L4109 |
| V3 收手续费 | `lp collect-fees` | `mantle_buildCollectFees` | `buildCollectFees` | L4944 |
| Aave supply | `aave supply` | `mantle_buildAaveSupply` | `buildAaveSupply` | L4262 |
| Aave borrow | `aave borrow` | `mantle_buildAaveBorrow` | `buildAaveBorrow` | L4344 |
| Aave repay | `aave repay` | `mantle_buildAaveRepay` | `buildAaveRepay` | L4511 |
| Aave withdraw | `aave withdraw` | `mantle_buildAaveWithdraw` | `buildAaveWithdraw` | L4581 |
| Aave 抵押开关 | `aave set-collateral` | `mantle_buildAaveSetCollateral` | `buildAaveSetCollateral` | L4679 |
| 通用包装 | — | — | `wrapBuildHandler` | L709 |

所有 builder 的核心依赖：
- ABIs —— `packages/core/src/lib/abis/{uniswap-v3, merchant-moe-lb, aave-v3-pool, erc20, wmnt}.ts`。
- Pool 发现 —— `packages/core/src/lib/pool-discovery.ts`。
- Revert 解码 —— `packages/core/src/lib/revert-decoder.ts`（`wrapBuildHandler` 在 `estimateGas` revert 时调用）。
- RPC —— `packages/core/src/lib/clients.ts` 导出的 `getPublicClient(network)`。

