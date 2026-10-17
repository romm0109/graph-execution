#!/usr/bin/env node
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { Command, InvalidArgumentError, Option } from "commander";
import { ConfigError } from "./config/config.js";
import { GraphError, loadTasks } from "./graph/load.js";
import { executionLayers, validateGraph } from "./graph/validate.js";
import { INSTALL_TARGETS, InstallError, type InstallTarget, installSkills } from "./install/skills.js";
import { ReadmeError, showReadme } from "./readme/readme.js";
import { resume, run } from "./runner/run.js";
import { startup } from "./runner/startup.js";
import { EXIT_ABORT, EXIT_SUCCESS, type ExitCode, exitCodeFor } from "./state/errors.js";
import { startUi } from "./ui/start.js";

export const PROVIDERS = ["claude", "codex", "opencode"] as const;
/** `fake` is a hidden provider used by tests. */
const ALL_PROVIDERS = [...PROVIDERS, "fake"] as const;
export type ProviderName = (typeof ALL_PROVIDERS)[number];

export interface RunOptions {
  spec?: string;
  provider?: ProviderName;
  /** Overrides `concurrency` in graph-execution.config.json; 3 when neither sets it. */
  concurrency?: number;
  model?: string;
  resume?: boolean;
  run?: string;
  /** commander's `--no-merge`: false keeps the result on `graph/<run-id>` only. */
  merge?: boolean;
}

class UsageError extends Error {}

/**
 * The only place that sets the process exit code: 0 success, 1 review loop exhausted, 2 abort or startup failure
 * (PRD §7.11). `immediately` exits right away, for commander's own usage errors and `--help`.
 */
function setExitCode(code: ExitCode, immediately = false): void {
  if (immediately) process.exit(code);
  process.exitCode = code;
}

function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("must be a positive integer");
  return n;
}

function parseProvider(value: string): ProviderName {
  if (!(ALL_PROVIDERS as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`must be one of: ${PROVIDERS.join(", ")}`);
  }
  return value as ProviderName;
}

function parseTarget(value: string): InstallTarget {
  if (!(INSTALL_TARGETS as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`must be one of: ${INSTALL_TARGETS.join(", ")}`);
  }
  return value as InstallTarget;
}

/** The spec must exist, be a readable file and be non-empty (PRD §7.11). */
async function checkSpec(file: string): Promise<void> {
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new UsageError(`spec file not found: ${file}`);
  }
  if (!info.isFile()) throw new UsageError(`spec is not a file: ${file}`);
  try {
    await access(file, constants.R_OK);
  } catch {
    throw new UsageError(`spec file is not readable: ${file}`);
  }
  if (info.size === 0) throw new UsageError(`spec file is empty: ${file}`);
}

async function runGraph(tasksDir: string, opts: RunOptions): Promise<void> {
  if (!opts.spec) throw new UsageError("missing required option --spec <file>");
  if (!opts.provider) throw new UsageError("missing required option --provider <name>");
  await checkSpec(opts.spec);

  const tasks = await loadTasks(tasksDir);
  validateGraph(tasks);
  const layers = executionLayers(tasks);

  console.log(`Task graph is valid: ${tasks.length} task(s) in ${layers.length} layer(s).`);
  layers.forEach((layer, i) => {
    console.log(`  ${i + 1}. ${layer.map((t) => t.id).join(" ")}`);
  });
  console.log(layers.map((layer) => layer.map((t) => t.id).join(" ")).join(" | "));

  const ctx = await startup({ cwd: process.cwd(), provider: opts.provider, references: [opts.spec, tasksDir] });
  console.log(`Run ${ctx.runId}: integration branch graph/${ctx.runId}`);
  if (opts.merge !== false && ctx.startBranch) {
    console.log(
      `Once the review is clean, the result is applied to ${ctx.startBranch} as uncommitted changes (--no-merge to skip).`,
    );
  }
  const result = await run(ctx, tasks, {
    specPath: opts.spec,
    tasksDir,
    model: opts.model,
    concurrency: opts.concurrency,
    ui: startUi,
    merge: opts.merge,
  });
  setExitCode(result.exitCode);
}

export function buildProgram(): Command {
  const program = new Command();
  // Set before adding subcommands so they inherit it.
  program.exitOverride((err) => {
    // Usage errors from commander (unknown option, bad value) abort with exit code 2.
    setExitCode(err.exitCode === 0 ? EXIT_SUCCESS : EXIT_ABORT, true);
  });
  program
    .name("graph-execution")
    .description("Execute a dependency graph of tasks with AI coding agents")
    .argument("[tasks-dir]", "folder of *.json task files")
    .option("--spec <file>", "PRD/spec file (required unless --resume)")
    .addOption(
      new Option("--provider <name>", `agent provider: ${PROVIDERS.join("|")} (required unless --resume)`).argParser(
        parseProvider,
      ),
    )
    .option("--concurrency <n>", "maximum tasks running in parallel (default: 3)", parsePositiveInt)
    .option("--model <m>", "model passed to the provider")
    .option("--resume", "resume an interrupted run")
    .option("--run <id>", "run id to resume (with --resume)")
    .option("--no-merge", "keep the result on graph/<run-id> instead of merging it into the current branch")
    .action(async (tasksDir: string | undefined, opts: RunOptions) => {
      if (opts.resume) {
        if (tasksDir || opts.spec || opts.provider) {
          throw new UsageError("--resume takes no tasks folder, --spec or --provider: they come from the saved run");
        }
        const result = await resume({ cwd: process.cwd(), runId: opts.run, ui: startUi, merge: opts.merge });
        setExitCode(result.exitCode);
        return;
      }
      if (opts.run) throw new UsageError("--run can only be used with --resume");
      if (!tasksDir) throw new UsageError("missing required argument <tasks-dir>");
      await runGraph(tasksDir, opts);
    });
  program
    .command("install")
    .description("Install bundled files into the current directory")
    .command("skills")
    .description("Install the to-tasks skill into .agents/skills and/or .claude/skills")
    .addOption(
      new Option("--target <target>", `where to install: ${INSTALL_TARGETS.join("|")}`)
        .default("agents")
        .argParser(parseTarget),
    )
    .option("--force", "overwrite existing skill folders")
    .action(async (opts: { target: InstallTarget; force?: boolean }) => {
      const installed = await installSkills({ target: opts.target, force: opts.force ?? false, cwd: process.cwd() });
      for (const dest of installed) console.log(`Installed to-tasks skill into ${dest}`);
      setExitCode(EXIT_SUCCESS);
    });
  program
    .command("readme")
    .description("Open the README in your browser")
    .option("--print", "print the README's markdown to stdout instead")
    .action(async (opts: { print?: boolean }) => {
      await showReadme({ print: opts.print ?? false });
      setExitCode(EXIT_SUCCESS);
    });
  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync(argv);
  } catch (err) {
    // Every failure aborts the run with exit code 2; state and worktrees are left in place.
    if (
      !(err instanceof GraphError || err instanceof UsageError || err instanceof ConfigError || err instanceof InstallError ||
        err instanceof ReadmeError) &&
      process.env.DEBUG
    ) console.error(err);
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    setExitCode(exitCodeFor(err));
  }
}

await main();
