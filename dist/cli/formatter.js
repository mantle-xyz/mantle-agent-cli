import chalk from "chalk";
function getLabelWidth(entries) {
    return Math.max(...entries.map(([label]) => label.length), 0);
}
function formatValue(value) {
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
        if (value.length === 0)
            return chalk.dim("[]");
        return value.map((item) => formatValue(item)).join(", ");
    }
    return JSON.stringify(value);
}
export function formatKeyValue(data, options = {}) {
    const { labels = {}, order } = options;
    const keys = order ?? Object.keys(data);
    const entries = [];
    for (const key of keys) {
        if (!(key in data))
            continue;
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
export function formatTable(rows, columns) {
    if (rows.length === 0) {
        console.log(chalk.dim("\n  No results.\n"));
        return;
    }
    const widths = columns.map((col) => {
        const headerWidth = col.label.length;
        const maxDataWidth = Math.max(...rows.map((row) => {
            const formatted = col.format ? col.format(row[col.key]) : formatValue(row[col.key]);
            return stripAnsi(formatted).length;
        }), 0);
        return Math.max(headerWidth, maxDataWidth);
    });
    const header = columns
        .map((col, i) => chalk.bold(col.label.padEnd(widths[i])))
        .join("   ");
    console.log(`\n  ${header}`);
    for (const row of rows) {
        const line = columns
            .map((col, i) => {
            const raw = col.format ? col.format(row[col.key]) : formatValue(row[col.key]);
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
export function formatJson(data) {
    console.log(JSON.stringify(data, null, 2));
}
export function formatError(error) {
    console.error(chalk.red(`\nError: ${error.message}`));
    if (error.code) {
        console.error(chalk.dim(`Code: ${error.code}`));
    }
    if (error.suggestion) {
        console.error(chalk.yellow(`Suggestion: ${error.suggestion}`));
    }
    console.error();
}
export function disableColors() {
    chalk.level = 0;
}
function stripAnsi(str) {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1B\[[0-9;]*m/g, "");
}
