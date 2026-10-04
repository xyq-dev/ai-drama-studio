import { readFile, stat } from "node:fs/promises";
import { inputWithinLimit, runQwenTextTrial } from "./qwen-text-trial";

export interface QwenTextTrialArgs {
  input: string;
  output: string;
  execute: boolean;
}

export function parseQwenTextTrialArgs(argv: readonly string[]): { ok: true; args: QwenTextTrialArgs } | { ok: false; code: string } {
  const tokens = argv[0] === "--" ? argv.slice(1) : argv;
  let input: string | undefined;
  let output: string | undefined;
  let execute = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--execute") {
      execute = true;
      continue;
    }
    if (token === "--input" || token === "--output") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) return { ok: false, code: token === "--input" ? "missing_input" : "missing_output" };
      if (token === "--input") input = value;
      else output = value;
      index += 1;
      continue;
    }
    return { ok: false, code: "unknown_argument" };
  }
  if (!input) return { ok: false, code: "missing_input" };
  if (!output) return { ok: false, code: "missing_output" };
  return { ok: true, args: { input, output, execute } };
}

export async function runQwenTextTrialCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): Promise<number> {
  const parsed = parseQwenTextTrialArgs(argv);
  if (!parsed.ok) {
    stderr(`status=rejected`);
    stderr(`code=${parsed.code}`);
    return 2;
  }
  let text: string;
  try {
    const info = await stat(parsed.args.input);
    if (!info.isFile() || !inputWithinLimit(info.size)) {
      stderr("status=rejected");
      stderr("code=input_too_large");
      return 2;
    }
    text = await readFile(parsed.args.input, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  } catch {
    stderr("status=rejected");
    stderr("code=input_unreadable");
    return 2;
  }
  if (!inputWithinLimit(Buffer.byteLength(text))) {
    stderr("status=rejected");
    stderr("code=input_too_large");
    return 2;
  }
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    stderr("status=rejected");
    stderr("code=invalid_input");
    return 2;
  }
  const result = await runQwenTextTrial({
    mode: parsed.args.execute ? "execute" : "dry_run",
    input: json,
    outputDir: parsed.args.output,
    env,
  });
  const write = result.exitCode === 0 ? stdout : stderr;
  for (const line of result.lines) write(line);
  return result.exitCode;
}

async function main(): Promise<void> {
  process.exitCode = await runQwenTextTrialCli(
    process.argv.slice(2),
    process.env,
    (line) => process.stdout.write(`${line}\n`),
    (line) => process.stderr.write(`${line}\n`),
  );
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("qwen-text-trial-cli.ts") || entry.endsWith("qwen-text-trial-cli.js")) {
  void main();
}
