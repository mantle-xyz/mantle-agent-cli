import chalk from "chalk";

export interface KeyValueOptions {
  labels?: Record<string, string>;
  order?: string[];
}

function getLabelWidth(entries: Array<[string, string]>): number {
  return Math.max(...entries.map(([label]) => label.length), 0);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return chalk.dim("null");
  }
  if (typeof value === "boolean") {
    return value ? chalk.green("true") : chalk.red("false");
  }
  if (typeof value === "number") {
    return chalk.cyan(String(value));
  }
  if (typeof value === "string") {
    if (/^0x[a-fA-F0-9]{40}$/.test(value)) {
      return chalk.yellow(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return chalk.dim("[]");
    return value.map((item) => formatValue(item)).join(", ");
  }
  return JSON.stringify(value);
}

export function formatKeyValue(
  data: Record<string, unknown>,
  options: KeyValueOptions = {}
): void {
  const { labels = {}, order } = options;
  const keys = order ?? Object.keys(data);
  const entries: Array<[string, string]> = [];

  for (const key of keys) {
    if (!(key in data)) continue;
    const label = labels[key] ?? key;
    entries.push([label, formatValue(data[key])]);
  }

  const width = getLabelWidth(entries);
  console.log();
  for (const [label, value] of entries) {
    console.log(`  ${chalk.bold(label.padEnd(width))}   ${value}`);
  }
  console.log();
}

export interface TableColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  /**
   * Render a cell. The second argument is the full row so a formatter can
   * cross-reference sibling fields (e.g. render a value differently based on
   * a unit discriminator in another column).
   */
  format?: (value: unknown, row?: Record<string, unknown>) => string;
}

export function formatTable(rows: Record<string, unknown>[], columns: TableColumn[]): void {
  if (rows.length === 0) {
    console.log(chalk.dim("\n  No results.\n"));
    return;
  }

  const widths = columns.map((col) => {
    const headerWidth = col.label.length;
    const maxDataWidth = Math.max(
      ...rows.map((row) => {
        const formatted = col.format ? col.format(row[col.key], row) : formatValue(row[col.key]);
        return stripAnsi(formatted).length;
      }),
      0
    );
    return Math.max(headerWidth, maxDataWidth);
  });

  const header = columns
    .map((col, i) => chalk.bold(col.label.padEnd(widths[i])))
    .join("   ");
  console.log(`\n  ${header}`);

  for (const row of rows) {
    const line = columns
      .map((col, i) => {
        const raw = col.format ? col.format(row[col.key], row) : formatValue(row[col.key]);
        const stripped = stripAnsi(raw);
        const padding = widths[i] - stripped.length;
        if (col.align === "right") {
          return " ".repeat(Math.max(padding, 0)) + raw;
        }
        return raw + " ".repeat(Math.max(padding, 0));
      })
      .join("   ");
    console.log(`  ${line}`);
  }
  console.log();
}

export function formatJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function formatError(error: {
  code?: string;
  message: string;
  suggestion?: string;
}): void {
  console.error(chalk.red(`\nError: ${error.message}`));
  if (error.code) {
    console.error(chalk.dim(`Code: ${error.code}`));
  }
  if (error.suggestion) {
    console.error(chalk.yellow(`Suggestion: ${error.suggestion}`));
  }
  console.error();
}

export function disableColors(): void {
  chalk.level = 0;
}

// ---------------------------------------------------------------------------
// Shared formatter for unsigned-tx build results.
//
// Every DeFi write command (approve / swap / lp / aave) emits the same shape:
//   { intent, human_summary, unsigned_tx: { to, value, chainId, data, ... },
//     warnings: string[], built_at_utc, ...extra }
//
// Previously this formatter was copy-pasted in four places. Behaviour was
// slowly drifting (each copy grew its own `poolParams` / `aaveReserve` branch).
// Keep the base rendering here and let callers pass domain-specific extra
// rows via `extraFields` / `extraLabels`.
// ---------------------------------------------------------------------------

export interface ExtraTxField {
  /** Field key as it appears in the printed order. */
  key: string;
  /** Human-readable label in the left column. */
  label: string;
  /** Value to render; skipped entirely when null/undefined. */
  value: unknown;
}

export function formatUnsignedTx(
  data: Record<string, unknown>,
  options: { extraFields?: ExtraTxField[] } = {}
): void {
  const tx = data.unsigned_tx as Record<string, unknown> | undefined;
  const warnings = (data.warnings ?? []) as string[];

  const fields: Record<string, unknown> = {
    intent: data.intent,
    human_summary: data.human_summary,
    tx_to: tx?.to,
    tx_value: tx?.value,
    tx_chainId: tx?.chainId,
    tx_data: truncateTxHex(tx?.data as string | undefined),
    tx_gas: tx?.gas ?? "auto",
    tx_maxFeePerGas: tx?.maxFeePerGas ?? "—",
    tx_maxPriorityFeePerGas: tx?.maxPriorityFeePerGas ?? "—",
    built_at: data.built_at_utc
  };

  const labels: Record<string, string> = {
    intent: "Intent",
    human_summary: "Summary",
    tx_to: "To",
    tx_value: "Value (hex)",
    tx_chainId: "Chain ID",
    tx_data: "Calldata",
    tx_gas: "Gas Limit",
    tx_maxFeePerGas: "Max Fee/Gas",
    tx_maxPriorityFeePerGas: "Priority Fee",
    built_at: "Built At"
  };

  for (const extra of options.extraFields ?? []) {
    if (extra.value === null || extra.value === undefined) continue;
    fields[extra.key] = extra.value;
    labels[extra.key] = extra.label;
  }

  formatKeyValue(fields, { labels });

  if (warnings.length > 0) {
    console.log("  Warnings:");
    for (const w of warnings) {
      console.log(`    - ${w}`);
    }
    console.log();
  }
}

/**
 * Never truncate calldata — agents and users need the full hex to sign
 * transactions. Previously this sliced the middle out, causing manual-paste
 * errors (dropped characters). For very long calldata we append a character
 * count so humans can sanity-check a paste without visual compare.
 */
function truncateTxHex(hex: string | undefined): string {
  if (!hex) return "null";
  if (hex.length <= 66) return hex;
  return `${hex} (${hex.length} chars)`;
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, "");
}
