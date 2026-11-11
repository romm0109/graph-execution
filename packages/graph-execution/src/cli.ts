#!/usr/bin/env node
import "./env.js";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { type ConfigOverrides, ConfigError, definedOverrides } from "./config/config.js";
import { longPathsEnv } from "./git/longpaths.js";
import { GraphError } from "./graph/load.js";
import { INSTALL_TARGETS, InstallError, type InstallTarget, installSkills } from "./install/skills.js";
import { launchWeb } from "./launch/launch.js";
import { cleanRuns } from "./cleanup/clean.js";
import { listRuns } from "./cleanup/list.js";
import { openRun } from "./launch/open.js";
import { preflight, UsageError } from "./launch/preflight.js";
import { type ManagerOptions, runManager } from "./manager/start.js";
import { ReadmeError, showReadme } from "./readme/readme.js";
import { resume, run, type RunResult } from "./runner/run.js";
import { startup } from "./runner/startup.js";
import { resumeSuite, runSuite, serveSuite, validateSuite } from "./suite/orchestrator.js";
import { EXIT_ABORT, EXIT_SUCCESS, type ExitCode, exitCodeFor } from "./state/errors.js";
import { RetryHub } from "./runner/retry-hub.js";
import { startUi } from "./ui/start.js";
import { withWebUi } from "./ui/withWeb.js";
import { appendRunLog, webJsonPath, webServeUi } from "./web/serve.js";
import { packageVersion } from "./version.js";

export const PROVIDERS = ["claude", "codex", "opencode", "qwen"] as const;
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
  web?: boolean;
  /** `--human-review` / `--no-human-review`; undefined lets the config decide. */
  humanReview?: boolean;
  attempts?: number;
  fixPasses?: number;
  validationRounds?: number;
  validateAt?: "task" | "end";
  /** `--validate-parallel` / `--no-validate-parallel`; undefined lets the config decide. */
  validateParallel?: boolean;
  /** `--idle-timeout <minutes>`: overrides `idleTimeoutMinutes`. */
  idleTimeout?: number;
  webServe?: boolean;
  /** `--reviewers <file>`; default: `$GRAPH_EXECUTION_REVIEWERS`, else the built-in reviewers. */
  reviewers?: string;
  /** graph-manager's terminal flag; the plain engine refuses it. */
  sandbox?: boolean;
}

/**
 * The only place that sets the process exit code: 0 success, 1 review loop exhausted, 2 abort or startup failure
 * (PRD §7.11). `immediately` exits right away, for commander's own usage errors and `--help`.
 */
function setExitCode(code: ExitCode, immediately = false): void {
  if (immediately) process.exit(code);
  process.exitCode = code;
}

const collect = (value: string, prev: string[]): string[] => [...prev, value];

function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("must be a positive integer");
  return n;
}

function parseNonNegativeInt(value: string): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isInteger(n) || n < 0) throw new InvalidArgumentError("must be an integer, 0 or more");
  return n;
}

function parseValidateAt(value: string): "task" | "end" {
  if (value !== "task" && value !== "end") throw new InvalidArgumentError("must be task or end");
  return value;
}

function parseMinutes(value: string): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError("must be a number of minutes, 0 or more");
  }
  return n;
}

/** The config keys the run flags override (docs/prd/run-options.md); only the flags given. */
function overridesOf(opts: RunOptions): ConfigOverrides {
  return definedOverrides({
    attempts: opts.attempts,
    fixPasses: opts.fixPasses,
    validationRounds: opts.validationRounds,
    validateAt: opts.validateAt,
    validateParallel: opts.validateParallel,
    idleTimeoutMinutes: opts.idleTimeout,
  });
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

async function runGraph(
  tasksDir: string | undefined,
  opts: RunOptions,
  ui: typeof startUi | ReturnType<typeof webServeUi>["ui"] | ReturnType<typeof withWebUi> = startUi,
  retry?: RetryHub,
): Promise<RunResult> {
  const pre = await preflight({
    cwd: process.cwd(),
    tasksDir,
    spec: opts.spec,
    provider: opts.provider,
    runId: opts.run,
    merge: opts.merge,
    humanReview: opts.humanReview,
    overrides: overridesOf(opts),
    reviewers: opts.reviewers,
  });
  if (pre.kind !== "run") throw new Error("unreachable");
  const { tasks, layers } = pre;
  tasksDir = tasksDir!;
  const spec = opts.spec!;

  console.log(`Task graph is valid: ${tasks.length} task(s) in ${layers.length} layer(s).`);
  layers.forEach((layer, i) => {
    console.log(`  ${i + 1}. ${layer.map((t) => t.id).join(" ")}`);
  });
  console.log(layers.map((layer) => layer.map((t) => t.id).join(" ")).join(" | "));

  const ctx = await startup({ cwd: process.cwd(), provider: opts.provider!, references: [spec, tasksDir] });
  console.log(`Run ${ctx.runId}: integration branch graph/${ctx.runId}`);
  if (opts.merge !== false && ctx.startBranch) {
    console.log(
      `Once the review is clean, the result is applied to ${ctx.startBranch} as uncommitted changes (--no-merge to skip).`,
    );
  }
  // Only a terminal can answer a retry prompt.
  const review = opts.humanReview ?? ctx.config.humanReview;
  if (review && ui === startUi) {
    // Human review happens in the web view: serve it next to the terminal view.
    ui = withWebUi(startUi);
    retry ??= new RetryHub();
  }
  retry ??= ui === startUi && process.stdout.isTTY ? new RetryHub() : undefined;
  const result = await run(ctx, tasks, {
    specPath: spec,
    tasksDir,
    model: opts.model,
    concurrency: opts.concurrency,
    ui,
    merge: opts.merge,
    humanReview: opts.humanReview,
    overrides: overridesOf(opts),
    ...(pre.reviewersFile ? { reviewersFile: pre.reviewersFile } : {}),
    ...(retry ? { retry } : {}),
  });
  return result;
}

/** The hidden `--web-serve` run process: the normal run with the web view, kept up after the end until Close. */
async function serveWeb(tasksDir: string | undefined, opts: RunOptions): Promise<void> {
  const web = webServeUi();
  const retry = new RetryHub();
  let exitCode: ExitCode = EXIT_ABORT;
  try {
    exitCode = opts.resume
      ? (await resume({ cwd: process.cwd(), runId: opts.run, ui: web.ui, merge: opts.merge, retry })).exitCode
      : (await runGraph(tasksDir, opts, web.ui, retry)).exitCode;
  } catch (err) {
    const handle = web.handle();
    if (!handle) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const runDir = web.runDir();
    if (runDir) appendRunLog(runDir, `error: ${message}`);
    handle.setFatal({ message, hint: "" });
  }
  const handle = web.handle();
  if (handle) {
    await handle.closed;
    const runDir = web.runDir();
    if (runDir) await rm(webJsonPath(runDir), { force: true });
  }
  setExitCode(exitCode);
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
    .version(packageVersion(), "-v, --version", "print the version and exit")
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
    .option("--web", "start the run in the background and open its live view in the browser")
    .option("--no-merge", "keep the result on graph/<run-id> instead of merging it into the current branch")
    .option("--human-review", "pause before applying so you can review the result in the web view")
    .option("--no-human-review", "apply without the human review, even if the config turns it on")
    .option("--attempts <n>", "attempts for every agent invocation; overrides attempts in the config (default: 3)", parsePositiveInt)
    .option("--fix-passes <n>", "fix passes in the review loop; overrides fixPasses (default: 3)", parseNonNegativeInt)
    .option(
      "--validation-rounds <n>",
      "fix rounds when validation fails; overrides validationRounds (default: 3)",
      parseNonNegativeInt,
    )
    .addOption(
      new Option("--validate-at <when>", "when the gate runs: task|end; overrides validateAt (default: task)").argParser(
        parseValidateAt,
      ),
    )
    .option("--validate-parallel", "run the validate commands all at once; overrides validateParallel")
    .option("--no-validate-parallel", "run the validate commands one after another, even if the config says parallel")
    .option(
      "--idle-timeout <minutes>",
      "stop an agent silent for this long, 0 = never; overrides idleTimeoutMinutes (default: 20)",
      parseMinutes,
    )
    .option("--reviewers <file>", "reviewers file (JSON); default: $GRAPH_EXECUTION_REVIEWERS, else the built-in code reviewer and live tester")
    .option("--sandbox", "run in a graph-manager sandbox (only in a graph-manager terminal)")
    .addOption(new Option("--web-serve").hideHelp())
    .action(async (tasksDir: string | undefined, opts: RunOptions) => {
      if (opts.sandbox) throw new UsageError("--sandbox needs graph-manager");
      if (opts.web && opts.webServe) throw new UsageError("--web and --web-serve cannot be used together");
      if (opts.web) {
        const args = process.argv.slice(2).filter((a) => a !== "--web");
        setExitCode(
          await launchWeb({
            args,
            cwd: process.cwd(),
            preflight: {
              cwd: process.cwd(),
              tasksDir,
              spec: opts.spec,
              provider: opts.provider,
              resume: opts.resume,
              runId: opts.run,
              merge: opts.merge,
              humanReview: opts.humanReview,
              overrides: overridesOf(opts),
              reviewers: opts.reviewers,
            },
          }),
        );
        return;
      }
      if (opts.webServe) {
        if (!process.env.GRAPH_EXECUTION_READY_FILE) throw new UsageError("--web-serve is internal");
        await serveWeb(tasksDir, opts);
        return;
      }
      if (opts.resume) {
        const pre = await preflight({
          cwd: process.cwd(),
          tasksDir,
          spec: opts.spec,
          provider: opts.provider,
          resume: true,
          runId: opts.run,
          humanReview: opts.humanReview,
          overrides: overridesOf(opts),
          reviewers: opts.reviewers,
        });
        const review = pre.kind === "resume" && pre.store.state.humanReview;
        const result = await resume({
          cwd: process.cwd(),
          runId: opts.run,
          ui: review ? withWebUi(startUi) : startUi,
          merge: opts.merge,
          ...(review || process.stdout.isTTY ? { retry: new RetryHub() } : {}),
        });
        setExitCode(result.exitCode);
        return;
      }
      setExitCode((await runGraph(tasksDir, opts)).exitCode);
    });
  program.hook("preSubcommand", (_thisCommand, actionCommand) => {
    const { web, webServe } = program.opts<RunOptions>();
    if ((web || webServe) && actionCommand.name() !== "suite") throw new UsageError(`unknown option '${web ? "--web" : "--web-serve"}'`);
  });
  program
    .command("install")
    .description("Install bundled files into the current directory")
    .command("skills")
    .description("Install the bundled skills (to-spec, to-tasks, run-graph) into .agents/skills and/or .claude/skills")
    .addOption(
      new Option("--target <target>", `where to install: ${INSTALL_TARGETS.join("|")}`)
        .default("agents")
        .argParser(parseTarget),
    )
    .option("--force", "overwrite existing skill folders")
    .action(async (opts: { target: InstallTarget; force?: boolean }) => {
      const { installed, skipped } = await installSkills({
        target: opts.target,
        force: opts.force ?? false,
        cwd: process.cwd(),
      });
      for (const dest of installed) console.log(`Installed ${path.basename(dest)} skill into ${dest}`);
      for (const dest of skipped) {
        console.log(`Skipped ${path.basename(dest)}: ${dest} already exists (use --force to overwrite)`);
      }
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
  program
    .command("open")
    .description("Open the live page of a run or suite started with --web")
    .option("--run <id>", "run or suite id; the latest of them when omitted")
    .action(async (opts: { run?: string }) => {
      // The root command declares --run too and takes it wherever it appears.
      setExitCode(await openRun({ cwd: process.cwd(), runId: opts.run ?? program.opts<RunOptions>().run }));
    });
  program
    .command("list")
    .description("List runs (status, age, size, branches) and leftover branches")
    .action(async () => {
      setExitCode(await listRuns({ cwd: process.cwd() }));
    });
  program
    .command("manager")
    .description("Start graph-manager, the web app for workspaces, terminals and runs")
    .option("--port <n>", "port to listen on (default: $GM_PORT, else 7420)")
    .option("--host <host>", "address to listen on (default: $GM_HOST, else 127.0.0.1)")
    .option("--data-dir <dir>", "where graph-manager keeps its data (default: $GM_DATA_DIR, else ~/.graph-manager)")
    .option("--workspaces-dir <dir>", "where repositories are cloned (default: $GM_WORKSPACES_DIR, else ~/graph-manager-workspaces)")
    .option("--no-open", "do not open the browser")
    .action(async (opts: ManagerOptions) => {
      // Exits right away: the manager's terminals and sockets would keep the event loop alive.
      setExitCode(await runManager(opts), true);
    });
  program
    .command("suite")
    .description("Run several features in parallel and integrate them")
    .option("--feature <tasks-dir:prd>", "a feature: its task folder and PRD (repeat)", collect, [] as string[])
    .addOption(new Option("--provider <name>", `agent provider: ${PROVIDERS.join("|")}`).argParser(parseProvider))
    .option("--model <m>", "model passed to the provider")
    .option("--concurrency <n>", "maximum tasks running in parallel, split across features", parsePositiveInt)
    .option("--no-merge", "keep the results on their branches instead of merging them into the current branch")
    .option("--resume", "resume the unfinished features of a suite")
    .option("--run <suite-id>", "the suite to resume (default: the latest)")
    .action(async (opts: RunOptions & { feature: string[] }) => {
      // The root command declares the same options and may take them.
      const root = program.opts<RunOptions>();
      const web = root.web || opts.web;
      const webServe = root.webServe || opts.webServe;
      if (web && webServe) throw new UsageError("--web and --web-serve cannot be used together");
      if (webServe && !process.env.GRAPH_EXECUTION_READY_FILE) throw new UsageError("--web-serve is internal");
      const resumeIt = opts.resume ?? root.resume;
      if (resumeIt && opts.feature.length > 0) throw new UsageError("--resume takes no --feature");
      const suiteId = opts.run ?? root.run;
      if (resumeIt && !web && !webServe) {
        setExitCode(await resumeSuite({ cwd: process.cwd(), suiteId }));
        return;
      }
      const provider = opts.provider ?? root.provider;
      if (!resumeIt && !provider) throw new UsageError("missing required option --provider <name>");
      const features = opts.feature.map((value) => {
        const i = value.lastIndexOf(":");
        if (i <= 0 || i === value.length - 1) throw new UsageError(`--feature must be <tasks-dir>:<prd>, got '${value}'`);
        return { tasksDir: value.slice(0, i), prd: value.slice(i + 1) };
      });
      const suiteOpts = {
        cwd: process.cwd(),
        features,
        provider: provider!,
        model: opts.model ?? root.model,
        concurrency: opts.concurrency ?? root.concurrency,
        merge: !(opts.merge === false || root.merge === false),
        humanReview: root.humanReview,
      };
      if (web) {
        setExitCode(
          await launchWeb({
            args: process.argv.slice(2).filter((a) => a !== "--web"),
            cwd: process.cwd(),
            noun: "suite",
            check: async () => {
              if (!resumeIt) await validateSuite(suiteOpts);
            },
          }),
        );
        return;
      }
      if (webServe) {
        setExitCode(await serveSuite(resumeIt ? { cwd: process.cwd(), suiteId } : suiteOpts));
        return;
      }
      setExitCode(await runSuite(suiteOpts));
    });
  program
    .command("clean [run-id]")
    .description("Delete unfinished runs, leftover branches and old applied runs")
    .option("--yes", "do not ask for confirmation")
    .option("--done", "also delete runs that finished without apply (--no-merge results)")
    .option("--force", "also delete branches with commits that are not merged anywhere else")
    .action(async (runId: string | undefined, opts: { yes?: boolean; done?: boolean; force?: boolean }) => {
      setExitCode(await cleanRuns({ cwd: process.cwd(), runId, yes: opts.yes, done: opts.done, force: opts.force }));
    });
  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  // Inherited by every git process and agent started from here.
  Object.assign(process.env, longPathsEnv());
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
