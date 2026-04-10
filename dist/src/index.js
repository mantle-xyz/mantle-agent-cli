// Lazy-import the MCP server so the package works without
// @modelcontextprotocol/sdk installed (CLI-only installs).
async function main() {
    const { runServer } = await import("./server.js");
    await runServer();
}
main().catch((error) => {
    // stderr logging only, so MCP stdio payload remains clean.
    console.error("Fatal:", error);
    process.exit(1);
});
export {};
