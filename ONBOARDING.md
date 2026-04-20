# Onboarding Guide — mantle-agent-scaffold

面向接手开发者的快速上手文档。读完本文档，你将理解：仓库的整体目的、包结构、核心设计模式、如何新增工具或命令、测试策略和开发工作流。

---

## 目录

1. [项目定位](#1-项目定位)
2. [仓库结构总览](#2-仓库结构总览)
3. [包职责划分](#3-包职责划分)
4. [核心设计模式](#4-核心设计模式)
5. [配置层说明](#5-配置层说明)
6. [安全机制](#6-安全机制)
7. [如何新增一个工具](#7-如何新增一个工具)
8. [如何新增一个 CLI 命令](#8-如何新增一个-cli-命令)
9. [测试策略](#9-测试策略)
10. [环境变量](#10-环境变量)
11. [开发工作流](#11-开发工作流)
12. [常见错误排查](#12-常见错误排查)

---

## 1. 项目定位

本仓库为 Mantle L2 网络提供一套 **AI 智能体可调用的工具集**，以 CLI 形式对外暴露。

**核心约束（必须始终满足）：**
- 所有写操作只返回 **未签名交易（unsigned_tx）**，绝不持有私钥、不签名、不广播
- 写操作的 token 和合约目标受 **白名单硬约束**，非白名单地址在构造 calldata 前即被拒绝
- 错误响应永远是结构化的 JSON，方便 AI 智能体程序化处理

**支持的协议：** Merchant Moe（V1 AMM / LB V2.2）、Agni Finance（V3）、Fluxion（V3）、Aave V3

---

## 2. 仓库结构总览

```
mantle-agent-scaffold/
├── packages/
│   ├── core/          # 所有业务逻辑（工具实现、配置、辅助库）
│   └── cli/           # CLI 入口，将 core 工具包装为命令行命令
├── tests/             # Vitest 单元测试（从项目根运行）
├── scripts/
│   └── signing-test/  # 主网黑盒签名测试（独立 npm 项目）
├── skills/            # AI 智能体工作流指南（git 子模块）
├── .github/workflows/ # CI 配置
├── package.json       # 根 workspace（管理所有包）
├── tsconfig.json      # 根 tsconfig（引用 packages/core 和 packages/cli）
└── vitest.config.ts   # 测试配置
```

### 分支说明

| 分支 | 说明 |
|------|------|
| `main` | 稳定版本，外部可直接使用 |
| `dev` | 开发分支，包含尚未合入 main 的新特性（见 `DEV_BRANCH.md`） |

---

## 3. 包职责划分

### `packages/core` — 业务逻辑核心

```
packages/core/src/
├── config/               # 静态配置数据
│   ├── chains.ts         # 链配置（RPC、chain_id、WMNT 地址等）
│   ├── tokens.ts         # 代币注册表（symbol → address/decimals）
│   ├── protocols.ts      # 协议合约地址（Agni/Moe/Fluxion/Aave）
│   ├── registry.json     # 扩展注册表（含 label、decimals、status）
│   ├── dex-pairs.ts      # DEX 交易对静态配置（V3 / LB / V1 AMM）
│   └── dexscreener-pools.json  # 本地池子快照（零 RPC 发现）
│
├── lib/                  # 共享辅助函数
│   ├── clients.ts        # viem PublicClient 工厂（带缓存、fallback RPC）
│   ├── network.ts        # 网络参数规范化（mainnet/sepolia 验证）
│   ├── endpoint-policy.ts# SSRF 防护（allowlist、DNS rebinding、只读 SQL）
│   ├── token-registry.ts # token 解析（symbol / 地址 → ResolvedTokenInput）
│   ├── pool-discovery.ts # V3 池子链上发现共享逻辑
│   ├── registry.ts       # registry.json 查询辅助
│   └── abis/             # 最小化 ABI 定义（ERC-20、Uniswap V3、Aave V3 等）
│
├── tools/                # 工具实现（每文件一个工具组）
│   ├── index.ts          # 汇总所有工具 → allTools: Record<string, Tool>
│   ├── chain.ts          # chain 类：chainInfo、chainStatus、tx 收据、gas 估算
│   ├── account.ts        # 余额、allowance
│   ├── token.ts          # token 元数据、价格、解析
│   ├── registry.ts       # 地址/协议注册表查询
│   ├── defi-read.ts      # DEX 读：报价、流动性、池子机会
│   ├── defi-lp-read.ts   # LP 读：findPools、V3/LB 仓位、analyzePool
│   ├── defi-lending-read.ts  # Aave V3 读：markets、仓位
│   ├── defi-write.ts     # 所有写操作：swap/wrap/approve/LP/Aave（返回 unsigned_tx）
│   ├── indexer.ts        # subgraph + SQL 查询
│   ├── diagnostics.ts    # RPC 健康检查、endpoint 探测
│   └── utils.ts          # formatUnits、parseUnits、encodeCall 等
│
├── capability-catalog.ts # 工具元数据目录（LLM 发现用）
├── types.ts              # Tool、Resource、Network 接口定义
└── errors.ts             # MantleMcpError + toErrorPayload
```

### `packages/cli` — CLI 层

```
packages/cli/src/
├── index.ts              # 程序入口，注册所有命令，处理全局 --json / --network 等
├── formatter.ts          # 终端输出格式化（formatKeyValue、formatTable、formatJson 等）
├── utils.ts              # RPC override 辅助
└── commands/             # 每个命令组一个文件
    ├── chain.ts           → mantle-cli chain ...
    ├── account.ts         → mantle-cli account ...
    ├── token.ts           → mantle-cli token ...
    ├── registry.ts        → mantle-cli registry ...
    ├── defi.ts            → mantle-cli defi ...（部分子命令的父级）
    ├── defi-swap.ts       → mantle-cli defi swap / wrap-mnt / unwrap-mnt
    ├── defi-approve.ts    → mantle-cli defi approve
    ├── defi-aave.ts       → mantle-cli aave ...
    ├── defi-lp.ts         → mantle-cli lp ...
    ├── indexer.ts         → mantle-cli indexer ...
    ├── diagnostics.ts     → mantle-cli diagnostics ...
    ├── catalog.ts         → mantle-cli catalog ...（工具发现）
    └── utils.ts           → mantle-cli utils ...（formatUnits 等）
```

---

## 4. 核心设计模式

### 4.1 Tool 接口

`packages/core/src/types.ts` 定义了所有工具必须满足的接口：

```ts
interface Tool {
  name: string;                              // 形如 "mantle_getChainInfo"
  description: string;                       // 供 LLM 路由使用
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}
```

每个工具：
- 通过 `normalizeNetwork(args)` 获取 `network: "mainnet" | "sepolia"`
- 通过 `MantleMcpError` 抛出结构化错误
- 返回纯 JSON 数据（不含渲染逻辑）

### 4.2 错误系统

所有错误必须使用 `MantleMcpError`，不得直接 throw `new Error()`：

```ts
throw new MantleMcpError(
  "ERROR_CODE",        // 大写下划线，供 AI 程序化处理
  "human message",     // 人类可读的描述
  "actionable hint",   // 告诉调用者下一步怎么做
  { key: "details" }  // 可选：调试用结构化字段
);
```

CLI 的 `index.ts` 捕获所有 `MantleMcpError` 并根据 `--json` 标志决定输出格式：

```jsonc
// --json 模式
{
  "error": true,
  "code": "UNSUPPORTED_NETWORK",
  "message": "...",
  "suggestion": "...",
  "details": {}
}
```

**常用错误码：**

| 错误码 | 含义 |
|--------|------|
| `UNSUPPORTED_NETWORK` | network 参数非法 |
| `INVALID_INPUT` | 参数校验失败 |
| `TOKEN_NOT_FOUND` | token symbol/地址无法解析 |
| `GAS_ESTIMATION_FAILED` | gas 估算失败（含 revert 原因） |
| `ENDPOINT_NOT_ALLOWED` | SSRF 防护拦截 |
| `INDEXER_ERROR` | subgraph/SQL 查询错误 |
| `INTERNAL_ERROR` | 未预期异常（兜底） |

### 4.3 CLI 命令模式

每个命令文件导出一个 `register*(parent: Command): void` 函数，在 `index.ts` 中统一注册。命令实现只做三件事：

```ts
export function registerChain(parent: Command): void {
  const group = parent.command("chain").description("...");

  group
    .command("info")
    .action(async (_opts, cmd) => {
      const globals = cmd.optsWithGlobals();           // 1. 获取全局参数
      const result = await allTools["mantle_getChainInfo"].handler({
        network: globals.network                        // 2. 调用 core 工具
      });
      if (globals.json) {
        formatJson(result);                             // 3a. JSON 输出
      } else {
        formatKeyValue(result, { ... });                // 3b. 表格输出
      }
    });
}
```

**核心原则：** CLI 层不含任何业务逻辑，只做参数传递和输出格式化。

### 4.4 写操作的 unsigned_tx 返回格式

所有 `mantle_build*` 工具返回：

```json
{
  "unsigned_tx": {
    "to": "0x...",
    "data": "0x...",
    "value": "0x0",
    "chainId": 5000
  },
  "human_summary": "Swap 10 WMNT → ~8.5 USDC via Agni",
  "warnings": []
}
```

签名和广播由调用方负责，工具本身永远不做。

### 4.5 RPC 客户端

`packages/core/src/lib/clients.ts` 提供缓存的 viem `PublicClient`：

- 主网有 3 个 fallback RPC（自动重试）
- 环境变量 `MANTLE_RPC_URL` 可覆盖（覆盖后不再使用 fallback）
- 支持 multicall3（批量链上调用）

---

## 5. 配置层说明

### 5.1 静态配置文件

| 文件 | 内容 | 修改场景 |
|------|------|---------|
| `config/chains.ts` | chain_id、RPC URLs、explorer、WMNT 地址 | 新增网络支持 |
| `config/tokens.ts` | token symbol → `{ address, decimals, name, symbol }` | 新增支持的代币 |
| `config/protocols.ts` | 协议名 → 合约地址 map | 新增协议或更新合约地址 |
| `config/registry.json` | 扩展注册表（含 label、decimals、status、notes） | 同上，更详细 |
| `config/dex-pairs.ts` | 静态 DEX 交易对配置（V3/LB/V1 AMM 分别建模） | 新增交易对 |
| `config/dexscreener-pools.json` | 本地池子快照 | 运行 `scripts/refresh-pools.mjs` 刷新 |

### 5.2 Token 解析优先级

`lib/token-registry.ts` 的 `resolveTokenInput()` 按以下顺序解析：

```
输入 symbol（如 "USDC"）
  → 1. MANTLE_TOKENS 静态查找（精确 symbol 匹配，大小写不敏感）
  → 2. 返回 { address, symbol, decimals }

输入地址（如 "0x09Bc..."）
  → 1. MANTLE_TOKENS 地址反查
  → 2. 链上 ERC-20 读取（decimals/symbol）
  → 3. 返回 { address, symbol, decimals }
```

写操作额外检查 `isWhitelistedTokenAddress()` — 不在白名单的地址直接抛出 `INVALID_INPUT`。

---

## 6. 安全机制

### 6.1 写操作白名单

`packages/core/src/config/protocols.ts` 的 `WHITELISTED_CONTRACTS_MAINNET` 和 `isWhitelistedTokenAddress()` 共同构成白名单：

- **Token 白名单**：写操作只允许 29 个指定 ERC-20（在 `MANTLE_TOKENS` 内）
- **合约白名单**：swap/LP 目标只允许 20 个指定协议合约
- 原始地址输入也会被拦截（通过 `resolveTokenInputForWrite()` 封装）

### 6.2 SSRF 防护（endpoint-policy.ts）

用户提供的外部 endpoint（indexer、diagnostics probe）在使用前必须通过：

1. **URL 解析**：必须是合法的 https:// URL
2. **私有 IP 拦截**：RFC 1918 私有段、127.0.0.1、::1 全部拒绝
3. **元数据端点拦截**：169.254.169.254、metadata.google.internal 等
4. **DNS rebinding 防护**：对 hostname 做 DNS 解析，检查解析结果是否为私有 IP
5. **域名 allowlist**：可通过 `MANTLE_ALLOWED_ENDPOINT_DOMAINS` 环境变量限制

### 6.3 只读 SQL 强制

`ensureReadOnlySql()` 在所有 SQL 查询执行前校验：
- 只允许 `SELECT` 或 `WITH ... SELECT`
- 拒绝多语句（`;` 后跟内容）
- 拒绝 INSERT / UPDATE / DROP 等关键词

---

## 7. 如何新增一个工具

以新增 `mantle_getXxx` 为例：

### 步骤 1：在对应的工具文件中实现 handler

```ts
// packages/core/src/tools/chain.ts（或新建文件）

export async function getXxx(args: Record<string, unknown>): Promise<any> {
  const { network } = normalizeNetwork(args);
  const param = args.param as string;

  if (!param) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "param is required.",
      "Provide a valid param value.",
      { param }
    );
  }

  // ... 实现逻辑
  return { result: "..." };
}
```

### 步骤 2：在工具文件末尾注册 Tool 对象

```ts
export const chainTools = {
  // ... 已有工具
  mantle_getXxx: {
    name: "mantle_getXxx",
    description: "一句话描述，供 LLM 路由决策使用。",
    inputSchema: {
      type: "object" as const,
      properties: {
        network: { type: "string", description: "mainnet or sepolia", default: "mainnet" },
        param: { type: "string", description: "what this param does" }
      },
      required: ["param"]
    },
    handler: getXxx
  }
};
```

### 步骤 3：确认已在 `tools/index.ts` 的合并列表中

```ts
// tools/index.ts
const toolList = [
  ...Object.values(chainTools),  // ← getXxx 会通过这里自动收入 allTools
  // ...
];
```

### 步骤 4：在 `capability-catalog.ts` 注册元数据

```ts
{
  id: "mantle_getXxx",
  name: "Get Xxx",
  category: "query",   // "query" | "analyze" | "execute"
  mutates: false,
  auth: "none",        // "none" | "optional" | "required"
  summary: "一句话说明工具用途。",
  cli_command: "mantle-cli chain xxx --param value --json",
  example: '{ "network": "mainnet", "param": "value" }',
  tags: ["chain", "xxx"]
}
```

### 步骤 5：更新 `tests/server-wiring.test.ts` 的工具列表

`tests/server-wiring.test.ts` 有一个精确匹配所有工具名的断言，需要把新工具名加入列表（按字母序）。

---

## 8. 如何新增一个 CLI 命令

### 步骤 1：在对应的命令文件中添加子命令

```ts
// packages/cli/src/commands/chain.ts

group
  .command("xxx")
  .description("描述")
  .requiredOption("--param <value>", "参数说明")
  .action(async (opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    const result = await allTools["mantle_getXxx"].handler({
      network: globals.network,
      param: opts.param
    });
    if (globals.json) {
      formatJson(result);
    } else {
      formatKeyValue(result as Record<string, unknown>, {
        order: ["result"],
        labels: { result: "Result" }
      });
    }
  });
```

### 步骤 2：更新 `capability-catalog.ts` 中的 `cli_command` 字段

确保元数据中的命令模板与实际命令一致，AI 智能体依赖这个字段调用 CLI。

---

## 9. 测试策略

### 9.1 单元测试（Vitest）

```bash
npm test                 # 运行全部测试（会先执行 npm run build）
npx vitest run           # 跳过 build 直接运行（需已有 dist/）
npx vitest run tests/chain-tools.test.ts  # 单文件
```

测试文件全在 `tests/` 根目录，按工具模块命名。Vitest 从项目根运行，通过 `tsconfig.json` 的 `references` 访问 `packages/*` 的类型。

**测试文件对应关系：**

| 测试文件 | 覆盖范围 |
|---------|---------|
| `chain-tools.test.ts` | mantle_getChainInfo/Status/Tx/Gas |
| `account-tools.test.ts` | 余额、allowance |
| `token-tools.test.ts` | 价格、解析 |
| `defi-read-tools.test.ts` | 报价、流动性 |
| `defi-write-allowance.test.ts` | approve 构建 |
| `defi-lb-positions.test.ts` | Merchant Moe LP 仓位 |
| `defi-lending-read-tools.test.ts` | Aave V3 读取 |
| `gas-estimation.test.ts` | gas 估算 + revert 解析 |
| `server-wiring.test.ts` | 所有工具的注册完整性 |
| `cli-integration.test.ts` | CLI 命令注册和 --help 输出 |
| `cli-formatter.test.ts` | 格式化函数 |
| `version-consistency.test.ts` | 各包版本一致性 |
| `open-source-readiness.test.ts` | CI workflow、社区文件完整性 |

### 9.2 签名测试（主网黑盒测试）

```bash
cd scripts/signing-test
npm install
cp .env.example .env    # 填入 TEST_PRIVATE_KEY

# 只构建 calldata，不签名不广播（推荐先跑这个）
npm run test:swap:dry
npm run test:lp:dry
npm run test:aave:dry

# 真实主网签名测试（需要钱包有少量 MNT）
npm run test:swap
npm run test:lp
npm run test:aave
```

这组测试 spawn 真实的 `node packages/cli/dist/index.js` 进程，解析 JSON 输出，用 viem 的 WalletClient 签名广播，并在链上验证结果。不依赖任何 mock。

### 9.3 测试中的 dependency injection

核心工具通过可选的 `deps` 参数支持注入 mock，避免测试需要真实 RPC 调用：

```ts
// 实现
export async function getChainStatus(
  args: Record<string, unknown>,
  deps: ChainStatusDeps = defaultDeps   // ← 默认使用真实 viem client
): Promise<any> { ... }

// 测试
const result = await getChainStatus(
  { network: "mainnet" },
  { getClient: () => mockClient, now: () => "2026-01-01T00:00:00Z" }
);
```

---

## 10. 环境变量

### 必须（基础运行）

无强制必须的变量，默认使用公共 RPC。

### 可选

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MANTLE_RPC_URL` | `https://rpc.mantle.xyz` | 主网 RPC 覆盖 |
| `MANTLE_SEPOLIA_RPC_URL` | `https://rpc.sepolia.mantle.xyz` | Sepolia RPC 覆盖 |
| `MANTLE_ALLOWED_ENDPOINT_DOMAINS` | 无（任意公网） | 逗号分隔的 endpoint 域名 allowlist |
| `MANTLE_ALLOW_HTTP_LOCAL_ENDPOINTS` | `false` | 允许 localhost http（开发用） |
| `COINGECKO_PRO_API_KEY` | 无 | CoinGecko Pro 价格 API（更高限速） |
| `COINGECKO_DEMO_API_KEY` | 无 | CoinGecko Demo API |

---

## 11. 开发工作流

### 初始设置

```bash
git clone <repo>
cd mantle-agent-scaffold
npm install
npm run skills:init          # 初始化 skills/ 子模块（AI 工作流指南）
npm run build                # 编译所有包（core → cli）
```

### 日常开发

```bash
# 修改 packages/core/src/ 后重新编译
npm run build -w packages/core

# 修改 packages/cli/src/ 后
npm run build -w packages/cli

# 一键重编并测试
npm test

# 类型检查（不编译）
npm run typecheck
```

### 增量 watch（无需每次手动 build）

```bash
# 终端 1：watch core
cd packages/core && npx tsc -w

# 终端 2：watch cli
cd packages/cli && npx tsc -w

# 终端 3：运行测试
npx vitest
```

### 验证 CLI 是否正常工作

```bash
node packages/cli/dist/index.js chain info
node packages/cli/dist/index.js chain info --json
node packages/cli/dist/index.js catalog list --json | head -30
```

---

## 12. 常见错误排查

### `Cannot find module '@mantleio/mantle-core/...'`

**原因：** `packages/core` 未编译，`dist/` 不存在。  
**解决：** `npm run build -w packages/core`

### 测试报错 `ERR_UNKNOWN_FILE_EXTENSION .ts`

**原因：** Vitest 通过 tsconfig references 加载，但包未 build。  
**解决：** `npm run build` 后再 `npm test`

### `ENDPOINT_NOT_ALLOWED` — 本地开发时访问 localhost endpoint

**原因：** endpoint-policy 默认拒绝 localhost。  
**解决：** `MANTLE_ALLOW_HTTP_LOCAL_ENDPOINTS=true` + `MANTLE_ALLOWED_ENDPOINT_DOMAINS=localhost`

### 工具列表测试失败（server-wiring.test.ts）

**原因：** 新增工具后未更新 `tests/server-wiring.test.ts` 的工具名列表。  
**解决：** 把新工具名按字母序加入测试的 expect 列表。

### `version-consistency` 测试失败

**原因：** `packages/core/package.json`、`packages/cli/package.json` 与根 `package.json` 版本不一致。  
**解决：** 三个文件的 `version` 字段保持相同值。

### 签名测试 `MISSING_SLIPPAGE_PROTECTION`

**原因：** `--minimum-out` 未提供，或提供了 `"0"` / `"0.0"` 等被视为无效的零值。  
**解决：** 提供实际计算后的最小输出量（raw integer 或 decimal 格式均可）。

---

## 关键数字速查

| 项目 | 数值 |
|------|------|
| 工具总数 | 47 个（`allTools` 中的 key） |
| 读工具 / 写工具 | ~35 读 / ~12 写（`mantle_build*`） |
| 主网 chain_id | 5000 |
| Sepolia chain_id | 5003 |
| WMNT 地址（主网） | `0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8` |
| multicall3 地址 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| 单元测试文件数 | 26 个 |
| defi-write.ts 行数 | ~5500 行（最大单文件） |
