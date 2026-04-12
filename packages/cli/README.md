# @mantleio/mantle-cli

CLI for Mantle L2 chain reads, DeFi queries, swaps, LP, and Aave operations.

## Install

```bash
npm install -g @mantleio/mantle-cli
```

Or use directly with npx:

```bash
npx @mantleio/mantle-cli chain info
```

## Discover Commands First

If you're using the CLI for the first time, start with the capability catalog to see what is available before choosing a command:

```bash
mantle-cli catalog list --json
mantle-cli catalog search "swap" --json
mantle-cli catalog show mantle_buildSwap --json
```

The catalog exposes each capability's category, wallet requirements, and exact CLI command template.

## Usage

```bash
mantle-cli chain info
mantle-cli chain status
mantle-cli registry resolve USDC --json
mantle-cli account balance 0x1234... --json
mantle-cli token prices --tokens USDC,WETH --json
mantle-cli diagnostics rpc-health
mantle-cli --help
```

### Options

- `--json` — output raw JSON
- `--no-color` — disable colored output
- `-n, --network <network>` — target network: mainnet (default) or sepolia
- `--rpc-url <url>` — override RPC endpoint

## Related packages

- [`@mantleio/mantle-core`](https://www.npmjs.com/package/@mantleio/mantle-core) — shared Mantle L2 business logic
- [`@mantleio/mantle-mcp`](https://www.npmjs.com/package/@mantleio/mantle-mcp) — MCP server for AI agents

## License

MIT
