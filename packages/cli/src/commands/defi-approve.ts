import type { Command } from "commander";
import { allTools } from "@mantleio/mantle-core/tools/index.js";
import { formatJson, formatUnsignedTx } from "../formatter.js";

/**
 * Top-level ERC-20 approve command:
 *   approve — Build unsigned ERC-20 approve for whitelisted spender
 *
 * Hoisted out of `swap` because approvals are not swap-specific — they are
 * required by swaps, LP, Aave, and any other DeFi interaction.
 */
export function registerApprove(parent: Command): void {
  parent
    .command("approve")
    .description("Build an unsigned ERC-20 approve for a whitelisted spender")
    .requiredOption("--token <token>", "token symbol or address")
    .requiredOption("--spender <address>", "whitelisted contract address to approve")
    .requiredOption("--amount <amount>", "decimal amount to approve, or 'max' for unlimited")
    .requiredOption("--owner <address>", "signer wallet (token holder). Required for deterministic nonce/gas pinning and allowance skip-check.")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const result = await allTools["mantle_buildApprove"].handler({
        token: opts.token,
        spender: opts.spender,
        amount: String(opts.amount),
        owner: opts.owner,
        network: globals.network
      });
      if (globals.json) {
        formatJson(result);
      } else {
        formatUnsignedTx(result as Record<string, unknown>);
      }
    });
}
