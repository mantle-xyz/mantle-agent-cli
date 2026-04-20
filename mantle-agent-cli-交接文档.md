# mantle-agent-cli 交接文档

> 本文档覆盖两部分内容：
> 1. **main 分支代码全面讲解** —— 项目整体设计、`core/tools/` 每个文件的职责与关键细节
> 2. **dev 分支迭代讲解** —— dev 相对 main 的 16 个 commit 逐一说明

---

# 第一部分：main 分支代码讲解

## 1. 项目概述

`mantle-agent-scaffold` 是一个**给 AI Agent 用的 Mantle L2 DeFi 工具库**。

**核心定位一句话：** 提供 47 个工具，覆盖 Mantle L2 上所有主要链上操作（链读取、代币余额、DEX 换币、LP 管理、Aave V3 借贷、诊断），但**永远不持有私钥、不签名、不广播**——所有写操作只返回未签名的 calldata，签名由外部完成。

### 技术栈

| 层次 | 技术 |
|------|------|
| 语言 | TypeScript 5.9（ESM，`"type": "module"`） |
| 区块链客户端 | **viem** 2.46（PublicClient、multicall3、ABI 编码） |
| Schema 校验 | **zod** 3.25 |
| CLI 框架 | **commander** 14 |
| 终端输出 | **chalk** 5 |
| 构建 | TypeScript compiler（`tsc`） |
| 测试 | **Vitest** 3.2 |
| 工程结构 | npm workspaces（monorepo） |

### 目录结构

```
mantle-agent-scaffold/
├── package.json                    ← workspace 根，scripts: build/test/skills:init
├── tsconfig.json                   ← 引用两个 packages/
├── tsconfig.base.json              ← 共享 TS 编译选项
├── vitest.config.ts                ← 测试入口
├── .env.example                    ← 环境变量说明
├── packages/
│   ├── core/                       ← @mantleio/mantle-core（核心业务逻辑）
│   │   └── src/
│   │       ├── index.ts            ← 公开导出：allTools、capabilityCatalog、types、errors
│   │       ├── types.ts            ← Tool、Resource、Network 接口定义
│   │       ├── errors.ts           ← MantleMcpError + toErrorPayload
│   │       ├── capability-catalog.ts ← LLM 发现元数据（47 条）
│   │       ├── config/             ← 链配置、token、协议、registry、pool 快照
│   │       ├── lib/                ← viem client 工厂、网络标准化、SSRF 防护、token 注册等
│   │       └── tools/              ← 11 个工具组文件 + index
│   └── cli/                        ← @mantleio/mantle-cli（CLI 包装层，零业务逻辑）
│       └── src/
│           ├── index.ts            ← Commander 程序入口
│           ├── formatter.ts        ← 输出格式化工具
│           ├── utils.ts            ← CLI 工具函数
│           └── commands/           ← 13 个命令组文件
├── tests/                          ← 26 个 Vitest 单元测试文件
├── scripts/
│   └── signing-test/               ← 真实主网签名黑盒测试
└── skills/
    └── mantle-openclaw-competition/ ← AI Agent skill 定义（静态目录）
```

---

## 2. 核心设计模式

### 2.1 `Tool` 接口——所有能力的统一抽象

```typescript
interface Tool {
  name: string;               // "mantle_getChainInfo"，LLM 路由用
  description: string;        // 给 LLM 看的功能描述
  inputSchema: { ... };       // JSON Schema，校验输入参数
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}
```

所有 47 个工具都实现这个接口，统一注册到 `allTools: Record<string, Tool>`（位于 `tools/index.ts`）。CLI 和任何消费者都从这个注册表取工具，不直接调用函数。

### 2.2 依赖注入（Deps 模式）

所有非 trivial 工具函数都定义 `Deps` 接口，并接受可选 `deps` 参数：

```typescript
// 生产环境：defaultDeps 使用真实 viem client 和真实 fetch
const defaultDeps = { getClient: getPublicClient, now: () => new Date().toISOString() };

// 测试时：只注入需要 mock 的 deps
export async function getChainStatus(args, deps = defaultDeps) { ... }
// test: getChainStatus({ network: "mainnet" }, { getClient: () => mockClient })
```

这使得单元测试完全不需要真实 RPC，26 个测试文件全部在隔离环境运行。

### 2.3 未签名交易返回模式

所有写工具（`build*` 系列）只返回未签名的 tx payload，永不签名或广播：

```json
{
  "unsigned_tx": {
    "to": "0x...",
    "data": "0x...",
    "value": "0x0",
    "chainId": 5000
  },
  "human_summary": "Swap 10 WMNT → ~8.5 USDC via Agni",
  "idempotency_key": "0x...",
  "warnings": []
}
```

### 2.4 结构化错误系统

所有错误用 `MantleMcpError(code, message, suggestion, details)`。机器可解析的错误码（`TOKEN_NOT_FOUND`、`INSUFFICIENT_ALLOWANCE`、`GAS_ESTIMATION_FAILED` 等）让 AI Agent 可以程序化处理失败，而不是解析自然语言错误信息。

### 2.5 SSRF 安全层

`lib/endpoint-policy.ts` 对所有用户提供的 URL 做检查：
- 强制 HTTPS（本地 HTTP 需显式 flag）
- 拦截 RFC 1918 私有 IP
- 拦截云元数据地址（169.254.169.254、metadata.google.internal）
- DNS 解析后二次检查 IP（防 DNS rebinding）
- 可选域名白名单（`MANTLE_ALLOWED_ENDPOINT_DOMAINS` env var）

### 2.6 多源价格验证

Token 价格并发请求 CoinGecko + DexScreener + DefiLlama，`crossValidatePrices()` 做置信度评分：
- 偏差 ≤3%：`confidence: "high"`
- 偏差 ≤15%：`confidence: "medium"`
- 偏差 >15% 或单一来源：`confidence: "low"`

---

## 3. `core/tools/` 文件逐一讲解

### 3.1 `chain.ts` — 链基础信息（4 个工具）

**职责：** 查链本身状态，最底层的工具。

| 工具 | 说明 |
|------|------|
| `getChainInfo` | 纯静态读取 `config/chains.ts`，**零 RPC**，返回 chainId / RPC URL / WMNT 地址 |
| `getChainStatus` | 并发 `getChainId` + `getBlockNumber` + `getGasPrice`，有 **chain ID 一致性校验**（实际返回 ≠ 期望则抛 `CHAIN_ID_MISMATCH`，防止接错链） |
| `getTransactionReceipt` | 查交易回执 + 交易本体。错误精确分类：用 viem 的 `TransactionReceiptNotFoundError` 类型区分"tx 不存在"和"RPC 故障"，不做字符串匹配 |
| `estimateGas` | 估 gas。关键保护：如果 `to` 是合约但没传 `data`，主动检测 bytecode，检测到合约则抛 `MISSING_CALLDATA`，防止用空 calldata 模拟导致误导估值 |

---

### 3.2 `account.ts` — 账户资产（4 个工具）

**职责：** 查一个地址的链上资产状态。

| 工具 | 说明 |
|------|------|
| `getNonce` | 查 `pending` nonce（mempool 状态）。注意：nonce 是 mempool 级的，秒级可能过期，文档明确警告要立刻用 |
| `getBalance` | 查原生 MNT 余额，返回 wei 和格式化两种形式 |
| `getTokenBalances` | **三阶段批量查询**：①并发解析 symbol→address；② **一次 multicall3** 批量查所有余额；③按原始输入顺序重组结果。部分失败不影响其他 token，`partial: true` 标记异常 |
| `getAllowances` | 查 `token → spender` 授权额度。`is_unlimited` 字段标记 ≥2^255 无限授权，`spender_label` 从 registry 反查合约名称 |

---

### 3.3 `token.ts` — 代币信息与价格（3 个工具）

**职责：** ERC-20 元数据读取 + 多源价格聚合。

| 工具 | 说明 |
|------|------|
| `getTokenInfo` | 链上读 name/symbol/decimals/totalSupply（4 个并发 `readContract`）。原生 MNT 走静态路径 |
| `getTokenPrices` | 见下方详述 |
| `resolveToken` | Symbol → 地址。两步：①查内部快速表；②从 canonical token list（外部 JSON）交叉校验。地址或精度不一致时抛 `TOKEN_REGISTRY_MISMATCH` |

**`getTokenPrices` 三源价格聚合：**

```
① 并发请求 CoinGecko + DexScreener + DefiLlama
         ↓
② crossValidatePrices()：
   CoinGecko 为主，次要源校验
   偏差 ≤3%  → confidence: "high"
   偏差 ≤15% → confidence: "medium"
   偏差 >15% → confidence: "low"
   CoinGecko 不可用 → dex & llama 都有且一致 → "medium"
   单一来源    → "low"
         ↓
③ base_currency=mnt 模式：price = tokenUSD / mntUSD
   置信度取两个价格中较低的（lowerConfidence()），防止置信度"洗白"
```

**CoinGecko 免费 API 特殊处理：** 免费 API 不支持批量请求（报错 code 10012），免费 tier 逐个 token 顺序请求；Pro/Demo tier 支持批量。代码通过 env var 自动识别 tier。

---

### 3.4 `registry.ts` — 合约地址注册表（2 个工具）

**职责：** 人类可读名称 → 链上地址，以及地址合法性校验。

| 工具 | 说明 |
|------|------|
| `resolveAddress` | 在 `registry.json` 里查找，支持 key / alias / label 三种匹配，大小写不敏感。`confidence` 基于 `source.retrieved_at` 时间戳（30 天内=high） |
| `validateAddress` | 验证格式、EIP-55 checksum、是否零地址。可选 `check_code=true` 发 `getBytecode` 确认合约部署，顺手反查 registry 得 label |

---

### 3.5 `utils.ts` — 底层编码工具（4 个工具）

**职责：** 纯计算，**零 RPC**。为 AI Agent 提供"escape hatch"，当没有专用命令时手动拼交易。

| 工具 | 说明 |
|------|------|
| `parseUnits` | 人类可读金额 → wei 整数（`"100" USDC + 6 decimals → "100000000"`） |
| `formatUnits` | 反方向：wei 整数 → 可读金额 |
| `encodeCall` | ABI 编码函数调用。支持 JSON ABI 数组或 human-readable 格式。传 `to` 地址时顺便组装 `unsigned_tx` |
| `buildRawTx` | 把已有 calldata 封装成 `unsigned_tx`，算 idempotency_key，做地址和 hex 格式校验 |

**关键安全 guard——`rejectTransferToProtocol()`：**

`encodeCall` 和 `buildRawTx` 都内置此检查：
```
解析 calldata 前 4 字节 selector
如果是 transfer(0xa9059cbb) 或 transferFrom(0x23b872dd)
  → 解析 recipient 地址
  → 如果 recipient 在白名单合约里 → throw BLOCKED_TRANSFER_TO_PROTOCOL
```
原因：向 Aave Pool 或 DEX Router 直接 `transfer()` 代币，合约不会记账，资金永久锁死无法找回。

---

### 3.6 `diagnostics.ts` — 连通性诊断（2 个工具）

**职责：** 检查 RPC 节点可用性。

| 工具 | 说明 |
|------|------|
| `checkRpcHealth` | 并发 `eth_chainId` + `eth_blockNumber`，返回延迟 ms、chain_id 一致性、当前块高。`rpc_url` 可选，不传用配置默认值 |
| `probeEndpoint` | 向用户指定 URL 发 JSON-RPC 调用。**方法名白名单**：只允许 `eth_chainId`/`eth_blockNumber`/`eth_getBalance`，防止 probe 被滥用。所有 URL 先过 `ensureEndpointSafe()` SSRF 检查 |

---

### 3.7 `indexer.ts` — 链外数据查询（2 个工具）

**职责：** 查 Subgraph（GraphQL）和自定义 indexer（SQL）。

| 工具 | 说明 |
|------|------|
| `querySubgraph` | POST GraphQL query。检测响应中 `hasNextPage=true`（递归检测整棵 JSON 树）时 warning 提示分页。响应大小上限 1MB（可配置） |
| `queryIndexerSql` | POST SQL query。执行前 `ensureReadOnlySql()`：只允许 `SELECT`/`WITH`，任何 DDL/DML 直接拒绝。结果行数上限 1000（可配置） |

---

### 3.8 `defi-read.ts` — DeFi 市场数据读取（5 个工具）

**职责：** DEX 报价、pool 发现、Aave 市场整体状态。

#### `getSwapQuote` — 三级报价架构

```
provider=best（推荐）：
  并发向 Agni + Fluxion + Merchant Moe 全部发报价请求
       ↓
  每个 provider 内部：
    Tier 1（链上）: QuoterV2.quoteExactInputSingle（staticcall，不消耗 gas）
      → 无直连 pool 时尝试 2-hop（通过 WMNT/USDC/USDT/WETH 做桥）
    Tier 2（降级）: DexScreener spot price 估算
      → 严重警告：无 slippage/depth 建模
       ↓
  取三者 estimatedOut 最大的，>20% 价差打 conflict warning
```

Merchant Moe 用 `LBQuoter.findBestPathFromAmountIn()` 而非 V3 QuoterV2，LB 是 Moe 独有的集中流动性设计。

**关键返回字段：**
```json
{
  "estimated_out_raw": "8500000",
  "minimum_out_raw": "8457500",       // 0.5% 滑点后，传给 buildSwap
  "resolved_pool_params": {
    "fee_tier": 500,
    "pool_address": "0x..."
  },
  "confidence": { "score": 0.85 },
  "source_trace": [...]               // 每个数据源的查询结果链路
}
```

#### `getPoolOpportunities` — 找最佳 pool 候选

两步流程：
1. **即时，零 RPC**：从 `dex-pairs.ts` 本地注册表 + `dexscreener-pools.json` 快照找候选
2. **最大努力**：DexScreener API 补充实时 liquidity_usd 和 volume_24h_usd

排名算法：`score = liquidity_score * 0.7 + volume_score * 0.3`

#### `getPoolLiquidity` — 读具体 pool 储备量

多源降级链：DexScreener → Subgraph → SQL Indexer → 全部失败 throw POOL_NOT_FOUND

USD 计算：用两个 token 的价格 × 储备量推算，与直接返回值偏差 >20% 时返回 `total_liquidity_usd_range`。

#### `getLendingMarkets` — Aave V3 市场整体

链上数据流：
1. `PoolDataProvider.getAllReservesTokens()` → reserve 列表
2. 对每个 reserve 并发查 4 个合约（reserveData / reserveConfig / assetPrice / Pool.getConfiguration）
3. **Isolation Mode 解码**：从 `Pool.getConfiguration()` 返回的 256 位 bitmap 手动解码：
   - bit 58 = `borrowingEnabled`
   - bit 61 = `borrowableInIsolation`
   - bit 212-251（40 位）= `debtCeiling`（原始值 /100 = USD 金额）

#### `getProtocolTvl` — 协议级 TVL

数据链：DefiLlama Protocol API → Subgraph → SQL Indexer。从 DefiLlama JSON 中找 `chainTvls.Mantle` 下的 TVL 时间序列，取最新数据点。

---

### 3.9 `defi-lp-read.ts` — LP 头寸管理（7 个工具）

**职责：** V3 池状态、用户持仓、tick 建议、池分析。

| 工具 | 说明 |
|------|------|
| `getV3PoolState` | 支持两种入参：直接传 `pool_address` 或传 `token_a + token_b + fee_tier + provider`（去 Factory 查地址）。一次 multicall 查 6 个状态：slot0 / liquidity / token0 / token1 / fee / tickSpacing。从 sqrtPriceX96 计算人类可读价格 |
| `getLBPairState` | Merchant Moe LB（Liquidity Book）状态。读 activeId，multicall 扫描活跃 bin 周围 ±25 个 bin 的储备量（最多 51 次 getBin，一次 multicall） |
| `getV3Positions` | 扫描用户所有 V3 LP NFT。**策略 1（可枚举）**：balanceOf → tokenOfOwnerByIndex × count。**策略 2（Transfer 事件扫描，fallback）**：扫 Transfer(from=0, to=owner) mint 事件，再 ownerOf 验证过滤。拿到 tokenId 后批量读头寸详情 + 当前 tick 判断是否在 range 内 |
| `getLBPositions` | 从 dex-pairs.ts 注册表找候选 pair，扫描活跃 bin ±25 个，批量查 `balanceOf(user, binId)` |
| `suggestTickRange` | 根据用户指定的 `range_width_pct` 计算 V3 tick_lower / tick_upper，按 tickSpacing 对齐（snapTickFloor/Ceil），返回对应价格 |
| `analyzePool` | 组合调用 getV3PoolState + 解读，返回当前价格、fee 百分比、多种策略预设（narrow/standard/wide）的 tick 范围及价格区间 |
| `findPools` | 从 dex-pairs.ts 注册表查包含目标 token 的所有 pair，支持按 provider 过滤 |

---

### 3.10 `defi-lending-read.ts` — Aave 用户头寸（1 个工具）

**唯一工具：`getAavePositions`**

（注意：`defi-read.ts` 的 `getLendingMarkets` 查市场整体状态，这里查**某个用户**的个人持仓。）

**5 步流程：**
```
1. Pool.getUserAccountData(user)
   → totalCollateral / totalDebt / availableBorrows / healthFactor（汇总）

2. Pool.getUserConfiguration(user)
   → 256 位 bitmap：bit i*2 = isBorrowing，bit i*2+1 = isUsingAsCollateral

3. multicall: Pool.getReserveData() × 所有 reserve
   → 动态获取 stableDebtToken 地址（aave-address-book 没有 Mantle 的地址，不能 hardcode）

4. multicall: balanceOf(user) × (aToken + variableDebtToken + stableDebtToken) × 所有 reserve
   → 一次 RPC 得到所有余额

5. 过滤供应=0 且 债务=0 的 reserve，只返回有持仓的
```

**健康度分级：**
- `healthFactor > 2` → `safe`
- `> 1.1` → `moderate`
- `> 1.0` → `at_risk`
- `≤ 1.0` → `liquidatable`
- `= MAX_UINT256` → `no_debt`（无债务的 Aave sentinel 值）

**`possible_missing_reserves` 检测：** 对比汇总 USD 与逐 reserve 累加，汇总显示有债务但逐 reserve 找不到时标注提示（说明有新 reserve 尚未收录）。

---

### 3.11 `defi-write.ts` — 构造未签名交易（14 个工具）

**核心架构：`wrapBuildHandler()`**

所有 build 函数都被这个 wrapper 包裹，wrapper 在业务逻辑之后自动：
1. 查 pending nonce（如果传了 `sender`）
2. 估 gas（`eth_estimateGas`）
3. 把 nonce 和 gas 注入 `unsigned_tx`

**14 个工具一览：**

| 工具 | 操作 | 核心合约 |
|------|------|---------|
| `buildApprove` | ERC-20 approve；支持 `amount_usd` 模式自动换算 raw；预先做 allowance 检查 | Token 合约 |
| `buildWrapMnt` | 原生 MNT → WMNT（`deposit()`） | WMNT |
| `buildUnwrapMnt` | WMNT → MNT（`withdraw(amount)`） | WMNT |
| `buildSwap` | DEX swap（见下方详述） | Agni/Fluxion Router / Moe LB Router |
| `buildAddLiquidity` | 加流动性 V3 / LB | V3 PositionManager / Moe LB Router |
| `buildRemoveLiquidity` | 撤流动性 V3 NFT burn / LB removeLiquidity | V3 PositionManager / Moe LB Router |
| `buildSetLBApprovalForAll` | Moe LB 特有：授权 Router 操作 LP token | Moe LB Pair |
| `buildAaveSupply` | Aave supply | Aave V3 Pool |
| `buildAaveBorrow` | Aave borrow | Aave V3 Pool |
| `buildAaveRepay` | Aave repay | Aave V3 Pool |
| `buildAaveWithdraw` | Aave withdraw | Aave V3 Pool |
| `buildAaveSetCollateral` | 开关某个资产的抵押属性 | Aave V3 Pool |
| `buildCollectFees` | V3 LP 收取手续费（需要 tokenId） | V3 PositionManager |
| `getSwapPairs`（只读） | 返回本地注册的 swap pair 配置，零 RPC | — |

**`buildSwap` 关键流程：**
```
1. 验证 provider 在白名单 → 拿 Router 地址
2. 解析 token（symbol → address + decimals）
3. 自动发现最优 pool（discoverBestV3Pool / Moe findBestPath）
4. 如果传了 owner，实际查 allowance
   → 不足 → throw INSUFFICIENT_ALLOWANCE（含 router 地址和需要 approve 的数量）
5. 交叉校验：provider 和 quote_provider 不一致 → 报错，防止 quote 和 build 用不同 pool
6. ABI 编码 exactInputSingle / exactInput
7. 返回 unsigned_tx + human_summary + warnings
```

**`buildAddLiquidity` 关键流程：**
```
1. 解析两个 token
2. 读当前 pool sqrtPriceX96 + tickSpacing
3. 如果未传 tick_lower/tick_upper，调 suggestTickRange 自动推算
4. 对齐 tick 到 tickSpacing
5. 检查两个 token 的 allowance（不足则在 human_summary 里附上 approve 步骤说明）
6. 编码 mint() calldata
```

---

### 3.12 四个 DeFi 文件的分工总结

```
defi-read.ts         → 市场视角（swap 报价、pool 发现、协议 TVL、Aave 市场整体）
defi-lp-read.ts      → LP 操作视角（V3/LB 池细节、用户持仓、tick 建议）
defi-lending-read.ts → 个人借贷视角（用户在 Aave 的具体头寸）
defi-write.ts        → 所有写操作（构造 calldata，不签名不广播）
```

**典型调用链——执行一次 swap：**
```
getSwapQuote → 确认路由和预估 output（defi-read）
  ↓ 拿到 router_address, minimum_out_raw
buildApprove → 构造 approve tx（defi-write）
  ↓ 签名广播，等确认
buildSwap → 构造 swap tx，内部 re-verify allowance（defi-write）
  ↓ 签名广播，等确认
getTransactionReceipt → 确认结果（chain）
```

---

## 4. 环境变量

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `MANTLE_RPC_URL` | `https://rpc.mantle.xyz` | 主网 RPC override |
| `MANTLE_SEPOLIA_RPC_URL` | `https://rpc.sepolia.mantle.xyz` | Sepolia RPC override |
| `MANTLE_ALLOWED_ENDPOINT_DOMAINS` | 任意公网 | SSRF 域名白名单 |
| `MANTLE_ALLOW_HTTP_LOCAL_ENDPOINTS` | `false` | 允许本地 HTTP（仅开发） |
| `COINGECKO_PRO_API_KEY` | — | CoinGecko Pro tier |
| `COINGECKO_DEMO_API_KEY` | — | CoinGecko Demo tier |
| `MANTLE_INDEXER_MAX_ROWS` | `1000` | SQL 结果行数上限 |

---

## 5. 测试策略

| 层次 | 位置 | 特点 |
|------|------|------|
| 单元测试 | `tests/*.test.ts` | Deps 注入 mock，零 RPC，全量 26 文件 |
| 一致性测试 | `tests/server-wiring.test.ts` | 断言 `allTools` 有且仅有预期的 47 个工具 |
| 集成测试 | `scripts/signing-test/` | 真实主网 + 真实私钥，有 dry-run 模式 |

---

# 第二部分：dev 分支迭代讲解

dev 分支对 main 有 16 个 commit（从最早到最新排序）：

---

## Commit 1 `98a58a2` — feat(lp): `findPools` 支持单边 token 查询

**背景：** 原来 `mantle_findPools` 必须同时传 `token_a` 和 `token_b`。AI Agent 只知道其中一个 token 时，无法知道它能和哪些 token 组成 pair。

**改动位置：** `packages/core/src/tools/defi-lp-read.ts`

**核心变化：**
- 新增 `mode: "pair" | "single_side"` 字段
- 只传 `token_a` 时，**自动发现所有可能的对手方 token**，三路来源取并集：
  1. `dexscreener-pools.json` 本地快照
  2. `listAllPairs()` 静态 pair 注册表
  3. `MANTLE_TOKENS[network]` 全量 token 表（兜底）
- 对手方发现**完全本地同步，零 RPC**；发现后再 multicall 批量链上验证 pool 存在
- multicall 分块防超出 RPC 批量上限：V3 每批 100 次（20 对手方 × 5 fee tier），LB 每批 100 次（10 对手方 × 10 bin step）
- 新增 `anchor_token`、`scanned.counterparts_scanned`、`scanned.snapshot_meta` 等字段
- `{ token_a: X, token_b: X }` 同一 token 现在抛 `INVALID_INPUT`（原来静默返回空）

---

## Commit 2 `5b2e03e` — feat(registry): 统一 token 注册表，补全 29 个 token 的链上验证 decimals

**背景：** `registry.json` 只有 6 个 token，`tokens.ts` 有 29 个。重叠部分没有漂移检测，且 registry 条目没有 `decimals` 字段，AI Agent 解析地址后还需额外查精度。

**改动位置：**
- `packages/core/src/config/registry.json` ← 主要变更，+363 行
- `packages/core/src/lib/registry.ts` ← `RegistryEntry` 增加可选 `decimals` 字段
- `packages/cli/src/commands/registry.ts` ← token category 条目渲染 decimals
- 新增 `scripts/verify-tokens.mjs` / `scripts/check-registry-checksums.mjs` / `scripts/check-registry-parity.mjs`
- 新增 `tests/registry-tools.test.ts`（循环遍历 MANTLE_TOKENS，断言每个 token 地址和 decimals 与 registry 一致）

**具体做了什么：**
- 把 `tokens.ts` 全部 29 个 ERC-20 迁入 `registry.json`，每条加 `decimals` 字段
- decimals/symbol/name 通过公开 RPC **链上查询验证**，mainnet+sepolia 零 mismatch
- 修正 12 个地址的 EIP-55 checksum（10 个新加的 xStocks token + 2 个 Fluxion 合约）
- 原生 MNT **故意排除** registry.json（`0x0` 作为 address 会误导地址解析）

---

## Commit 3 `b5378c1` — feat(lp): `findPools` 从按需链上扫描改为本地快照零 RPC

**背景：** 原来每次 `findPools` 发 100-300 个 RPC（`getPool` × fee tier + pool.liquidity）。

**改动位置：**
- `packages/core/src/tools/defi-lp-read.ts` ← 移除 `scanPairsOnChain()`，加入 `scanPairsFromSnapshot()`
- 新增 `scripts/refresh-pools.mjs` ← 手动刷新快照
- `packages/cli/src/commands/defi-lp.ts` / `formatter.ts` ← USD 流动性展示

**架构变化：**

```
之前：findPools 调用 → 100-300 次 RPC
之后：findPools 调用 → 同步读 dexscreener-pools.json → 0 RPC
     DexScreener HTTP 只用于已发现 pool 的 TVL/volume 数据补充
```

**`refresh-pools.mjs` 做什么（手动运行）：**
1. 拉 DexScreener Mantle 全量 pool
2. 按最低流动性和 provider 白名单过滤
3. **逐个链上 multicall 验证**（ERC-20 symbol / V3 token0+token1+fee / LB getBinStep + getTokenX+Y）
4. 原子写入（tmp 文件 + rename）

**新字段：**
- `liquidity_unit: "dexscreener_usd_snapshot"` ← 明确标记快照来源
- `snapshot_meta: { fetched_at, total_pools }` ← 在 pair 和 single-side 两种模式都出现，AI Agent 可知数据新鲜度

**新测试：** `tests/defi-find-pools.test.ts`（+7 个），固化零 RPC 不变式（同步执行、unit tag、USD 整数化、去重、对手方过滤、sepolia 空路径、静态注册表回退、自 pair 排除）

---

## Commit 4 `2618172` — feat(whitelist+defi): OpenClaw 白名单强制执行 + CLI whitelist 命令树 + revert 解码器

这是 dev 分支**最大的 commit**（27 个文件，+2109/-931 行），由三个子任务组成。

### 子任务 A：白名单强制执行

**背景：** OpenClaw 竞赛 Hard Constraint #10：只能操作官方白名单 29 个 ERC-20 和 20 个协议合约。原代码没有强制执行层。

**改动位置：**
- `packages/core/src/config/protocols.ts` ← 重写为白名单范围，新增 `WHITELISTED_CONTRACTS_MAINNET` 集合（20 个地址）和 `isWhitelistedTokenAddress()` 函数
- `packages/core/src/config/tokens.ts` ← 裁剪至白名单 29 个 token
- `packages/core/src/config/aave-reserves.ts` ← 裁剪至白名单 reserve
- `packages/core/src/config/dex-pairs.ts` ← 重新对齐
- `packages/core/src/config/dexscreener-pools.json` ← 重新生成（两侧都在白名单才保留，去掉流动性下限）

**强制逻辑：**

```
write-side tools (buildSwap / buildApprove / buildAddLiquidity / buildAaveSupply...)
  → resolveTokenInput() 先查 tokens.ts（白名单范围内的 token）
  → 如果是原始地址输入（不是符号），调 isWhitelistedTokenAddress() 检查
  → 非白名单 → 在构造任何 calldata 之前 throw WHITELIST_VIOLATION
```

**为什么原来有漏洞：** `resolveTokenInput` 对未知地址会做链上 ABI 读（fallback），能读到 symbol/decimals 就允许继续。这对读工具无害，但写工具传任意地址可绕过白名单。

### 子任务 B：新增 `mantle-cli whitelist` 命令树

**改动位置：** `packages/cli/src/commands/whitelist.ts`（新文件，453 行）

```
mantle-cli whitelist summary               ← 概览：token 数、合约数、协议状态
mantle-cli whitelist tokens                ← 列出所有白名单 token（symbol/address/decimals）
mantle-cli whitelist contracts             ← 列出所有白名单合约（label/address/category）
mantle-cli whitelist protocols             ← 列出启用的协议
mantle-cli whitelist show <identifier>     ← 查单个 token 或合约详情
```

所有子命令支持 `--json` 和 `--network`，在 `next_commands` 字段里带入当前网络，防止 AI Agent 下一步命令丢失网络参数。

### 子任务 C：revert 解码器

**背景：** 生产事故——AI Agent 执行 `buildAaveSetCollateral` 时 gas 估算失败，错误里看不到原始 revert bytes，Agent 自行"推断"了一个 Aave 自定义错误表，最终执行了错误操作（`--disable` 了不该 disable 的资产）。

**改动位置：** `packages/core/src/lib/revert-decoder.ts`（新文件，259 行）、`tools/chain.ts`、`tools/defi-write.ts`

**解码器逻辑：**
```
GAS_ESTIMATION_FAILED 发生时：
  1. 走 viem 错误的 cause chain（可能嵌套多层：error.cause.data.data...）
  2. 提取第一个 0x-prefixed hex payload
  3. 解码：
     0x08c379a0 → Error(string)            → 提取 revert message
     0x4e487b71 → Panic(uint256)           → 解码 panic code
     已知 Aave V3 custom error selector    → 解码为名称
     未知 selector                         → 原样返回 revert_raw + revert_selector
                                            （让 Agent 自己查，不要瞎猜）
```

GAS_ESTIMATION_FAILED 错误的 `details` 新增字段（全部 `revert_` 前缀，避免碰撞）：
```json
{
  "revert_raw": "0x17c5a78e...",
  "revert_selector": "0x17c5a78e",
  "revert_name": "CollateralCannotCoverNewBorrow",
  "revert_args": [...],
  "revert_message": "CollateralCannotCoverNewBorrow"
}
```

**新测试：** `tests/revert-decoder.test.ts`（11 个），覆盖嵌套 cause chain、空 revert、未知 selector、Error/Panic 解码、BigInt 序列化，以及通过 mock estimateGas 注入的端到端 buildSwap 集成测试。

---

## Commit 5 `d4cc396` — feat(dex-pairs): 补全缺失 pool，加 Merchant Moe V1 AMM 支持

**背景：** `dex-pairs.ts` 只有部分 pool，与 `dexscreener-pools.json` 59 个 pool 不一致；且之前只有 LB V2 格式，Moe V1 AMM 没有数据结构。

**改动位置：**
- `packages/core/src/config/dex-pairs.ts` ← +186 行
- `packages/core/src/tools/defi-lp-read.ts`、`defi-write.ts` ← 消费侧适配
- 新增 `scripts/verify-dex-pairs.mjs`（268 条链上验证，0 错误）

**数据模型变化：**
```typescript
// 新增 MoeV1Pair 判别联合类型（provider: "merchant_moe", version: 1，无 bin_step/fee_tier）
type DexPair = V3Pair | MoeLBPair | MoeV1Pair;
function isMoeLBPair(p: DexPair): p is MoeLBPair  // 新类型守卫
```

新增 6 个 V1 AMM pool：MOE/WMNT、MOE/USDT、WETH/USDC、cmETH/WMNT、USDe/WMNT、FBTC/WMNT，以及 11 个缺失的 LB v2 / V3 pool。V1 pool 通过 Moe LB Router V2.2 的 `versions:[0]` 参数路由。

---

## Commit 6 `92fb8d1` — fix(aave): 补上 Aave V3 registry 里缺失的 `pool_addresses_provider`

**背景：** `loadAaveV3Markets()` 需要调 `PoolAddressesProvider.getPriceOracle()` 获取 oracle 地址，但 `MANTLE_PROTOCOLS.aave_v3.contracts` 里**从未配置** `pool_addresses_provider`。导致 `mantle-cli aave markets` 在 mainnet 始终抛 `LENDING_DATA_UNAVAILABLE`。

**改动：** `packages/core/src/config/protocols.ts`

加入官方地址 `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f`（来源：bgd-labs/aave-address-book `AaveV3Mantle.sol`）。

**不加入白名单的原因：** 该地址只用于 `eth_call` 读数据，永远不会出现在 `unsigned_tx.to` 里，与 `quoter_v2` 同等处理。

---

## Commit 7 `6866240` — refactor(cli): 合并冗余 DEX 命令，提取共享 formatter

**背景：** CLI 有 4 个已被替代的命令继续存在；5 个文件里重复了相同的 `unsigned_tx` 格式化代码（约 60 行）。

**删除的命令：**

| 被删命令 | 替代命令 |
|---------|---------|
| `defi analyze-pool` | `lp analyze` |
| `defi lending-markets` | `aave markets` |
| `lp lb-positions` | `lp positions --provider merchant_moe` |
| `lp top-pools` | 死代码，直接删 |

**新共享 formatter：** `packages/cli/src/formatter.ts` 新增 `formatUnsignedTx(data, { extraFields? })`，统一渲染 `to / data / value / chainId / gas_limit / nonce`。各命令通过 `extraFields` 注入特有字段（swap 注 `pool_params`，aave 注 `aave_reserve`）。

同步更新：`capability-catalog.ts` cli_command 示例、signing-test 脚本、CLI 集成测试。

---

## Commit 8 `87d1bab` — fix(swap): `--minimum-out` 同时接受 decimal 和 raw integer

**背景：** 生产事故——Agent 拿到 `minimum_out_raw = "8457500"` 后，错误地用 `parseUnits("8457500", 6)` = `8457500000000`，比实际应传值大 10⁶ 倍，导致 swap 永远不能满足滑点条件。

**改动位置：**
- `packages/core/src/tools/defi-write.ts` ← 新增 `parseAmountOutMin()` 辅助函数
- `packages/cli/src/commands/defi-swap.ts` ← 新增 `--minimum-out` 别名，保留 `--amount-out-min` 向后兼容

**`parseAmountOutMin()` 解析规则：**
```
包含 "."  → parseUnits(value, tokenOut.decimals)   （decimal 格式，如 "8.4575"）
纯数字    → BigInt(value)                           （raw integer，如 "8457500"）
其他       → throw INVALID_AMOUNT_FORMAT + hint
精度过高   → throw（如 "8.45750001" 但 token 只有 6 decimals，拒绝静默截断）
```

**`slippage_protection` echo 字段：** buildSwap 全部 4 条返回路径新增：
```json
{
  "slippage_protection": {
    "input_raw_or_decimal": "8.4575",
    "resolved_raw": "8457500",
    "resolved_decimal": "8.457500",
    "token_out_decimals": 6
  }
}
```

**新测试：** `tests/swap-minimum-out-parsing.test.ts`（12 个）：decimal 输入、raw integer 输入、别名等价、"事故复现"输入（212195 这种整数）、错误格式、精度过高、echo 字段形状。

---

## Commit 9 `c5f3604` — fix(swap): 对抗性审查发现的 `minimum-out` 解析细节修复

**背景：** 对 commit 8 做了 adversarial review，发现边界 case。

**改动位置：** `packages/core/src/tools/defi-write.ts`

对 `parseAmountOutMin` 的细节强化：负数 / 零值 / 科学计数法格式的正确拒绝或处理。与 commit 8 是同一次功能的两步提交。

---

## Commit 10 `aa4109e` — feat(signing-test): 新增 Merchant Moe 多版本 swap 测试场景

**改动位置：** `scripts/signing-test/src/scenario-moe-swap.ts`（新文件，588 行）

新增三个真实主网签名测试场景：
1. **LB V2.2 直连 swap**：tokenIn/Out 直接有 LB pool
2. **LB V2.2 自动路由**：通过 LFJ Aggregator 找最优路径
3. **V1 AMM swap**：走旧版 AMM（`versions:[0]`）

同时补充 MOE token 到 `constants.ts` 和 `helpers.ts` 的余额展示。

---

## Commit 11 `8a68925` — chore(skills): 将 skills git submodule 改为静态目录

**背景：** git submodule 在 CI 和团队协作中需要 `--recursive` clone，外部变化无法版本控制。

**改动：** 删除 `.gitmodules` 和 `skills` gitlink，将 `skills/mantle-openclaw-competition/` 直接提交进仓库。

**静态目录结构：**
```
skills/mantle-openclaw-competition/
├── SKILL.md                         ← v0.1.24，含 WHITELIST-ONLY 硬约束 + signable_tx 签名流
├── agents/openai.yaml               ← OpenAI Agent 配置
├── integrity.json
└── references/
    ├── asset-whitelist.md           ← 21 个 token + 4 个协议族
    ├── aave-workflow.md
    ├── lp-workflow.md
    ├── safety-prohibitions.md       ← 规则 11 signable_tx + 11a human_summary
    └── swap-workflow.md
```

合并了 whitelist-enforcement 分支（v0.1.24）和 main 的 signable_tx 分支（v0.1.18）的内容。

---

## Commit 12 `1d7a1a7` — chore: 移除 MCP 包和所有 MCP 相关内容

**背景：** `packages/mcp/` 是早期 MCP Server 实现，项目转向 CLI-first，MCP 包废弃。

**删除内容：**
- `packages/mcp/` 整个目录
- `e2e/` 目录（基于 MCP 的端到端测试）
- `SERVER_INSTRUCTIONS.md`、`vitest.e2e.config.ts`
- MCP-only 测试文件（resources、skills-path、prompts-v0-2、docs-alignment）

**同步更新：** `package.json` 删除 MCP scripts 和 AI SDK devDependencies；`tsconfig.json` 移除相关 reference；`tests/` 移除 MCP 相关断言。

---

## Commit 13 `85881d3` — docs: 新增 `DEV_BRANCH.md` 开发者引导

新增 `DEV_BRANCH.md`，内容包括：
- dev 分支相对 main 的功能差异清单
- 开发者 onboarding 步骤
- dev-only 功能的"已知差异"说明

---

## Commit 14 `f7698b0` — chore: 删除 docs 站点及相关内容

**背景：** 基于 Nextra 的 Next.js 文档站维护成本高，CI 里每次 push 都跑 docs build。

**删除内容：**
- `docs/` 整个目录（Nextra Next.js app）
- `.github/workflows/docs-pages.yml`（GitHub Pages 部署 workflow）
- `tests/docs-pages-config.test.ts`、`tests/docs-workflow-compatibility.test.ts`

**同步更新：** `package.json`（删 `docs:dev`/`docs:build`）、`ci.yml`（删 docs install+build 步骤）

---

## Commit 15 `1562f15` — docs: 重写 README，完整收录全部 47 个工具

**改动位置：** `README.md`（+192/-71 行）、`tests/skills-submodule.test.ts`

- Available Tools 从 19 个 → 47 个，按类分组（chain/account/token/registry/DEX/LP/lending/indexer/diagnostics/utilities/write 系列）
- Skills 章节更新为静态 skill 说明
- CLI 命令 section 扩展，加所有命令组的具体示例
- 新增 Safety Rule #7：签名后等确认再发下一笔交易
- 更新 `skills-submodule.test.ts` 以匹配静态 skill 目录结构

---

## Commit 16 `167dc22` — chore: 升级 CLI 包的 mantle-core 依赖版本

**改动：** `packages/cli/package.json`

`@mantleio/mantle-core` 从 `0.1.11` → `0.1.18`，保持 cli 和 core 包版本一致。

---

## dev 分支变化全景总结

| 类别 | 具体变化 |
|------|---------|
| **安全加固** | 白名单强制执行（写操作全面封锁非白名单地址） + revert 解码器（事故溯源，不让 Agent 猜错误原因） |
| **功能增强** | `findPools` 单边 token 查询；`whitelist` 命令树（5 个子命令）；Moe V1 AMM 支持 |
| **性能优化** | `findPools` 零 RPC 快照化（100-300 RPC → 0 RPC） |
| **数据修复** | token registry 统一（29 token 全覆盖，链上验证 decimals）；Aave `pool_addresses_provider` 修复；dex-pairs 补全 59 个 pool |
| **Bug 修复** | `minimum-out` 单位转换事故修复（双格式接受 + slippage_protection echo 回显） |
| **架构清理** | 删 MCP 包、删 docs 站、删 4 个冗余 CLI 命令、统一 unsigned_tx formatter、submodule 转静态目录 |
| **工具链** | 新增 4 个脚本（`refresh-pools`、`verify-dex-pairs`、`verify-tokens`、`verify-dex-pairs`）；新增 4 套测试（find-pools、registry-tools、revert-decoder、swap-minimum-out-parsing） |

---

*文档生成时间：2026-04-20*
