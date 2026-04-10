import { runServer } from "./server.js";
runServer().catch((error) => {
    // stderr logging only, so MCP stdio payload remains clean.
    console.error("Fatal:", error);
    process.exit(1);
});
