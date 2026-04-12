# @mantleio/mantle-mcp

MCP server for AI-driven Mantle L2 development — chain reads, simulation, and unsigned transaction building.

## Install

```bash
npm install @mantleio/mantle-mcp
```

## Usage

Run the MCP server over stdio:

```bash
npx @mantleio/mantle-mcp
```

Or add to your Claude Desktop / MCP client configuration:

```json
{
  "mcpServers": {
    "mantle": {
      "command": "npx",
      "args": ["@mantleio/mantle-mcp"]
    }
  }
}
```

## Related packages

- [`@mantleio/mantle-core`](https://www.npmjs.com/package/@mantleio/mantle-core) — shared Mantle L2 business logic
- [`@mantleio/mantle-cli`](https://www.npmjs.com/package/@mantleio/mantle-cli) — CLI for Mantle chain reads, DeFi queries, and transaction building

## License

MIT
