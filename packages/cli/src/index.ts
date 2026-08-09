import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type CliIO = {
  log(message: string): void;
  error(message: string): void;
};

type ProjectPackage = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

export async function runCli(
  arguments_: string[] = process.argv.slice(2),
  io: CliIO = console,
): Promise<number> {
  const [command = "help"] = arguments_;

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp(io);
    return 0;
  }

  if (command === "init") {
    return initializeProject(process.cwd(), io);
  }

  if (command === "doctor") {
    return runDoctor(process.cwd(), io);
  }

  io.error(`Unknown PatchLens command: ${command}`);
  printHelp(io);
  return 1;
}

async function initializeProject(projectRoot: string, io: CliIO): Promise<number> {
  const packagePath = path.join(projectRoot, "package.json");
  const projectPackage = await readProjectPackage(packagePath);
  if (!projectPackage) {
    io.error("PatchLens could not find package.json in the current directory.");
    return 1;
  }

  const configDirectory = path.join(projectRoot, ".patchlens");
  const configPath = path.join(configDirectory, "config.json");
  if (await exists(configPath)) {
    io.log("PatchLens is already initialized in this project.");
    return 0;
  }

  const framework = detectFramework(projectPackage);
  const config = {
    version: 1,
    framework,
    projectRoot: ".",
    preview: {
      command: inferDevCommand(projectPackage),
      url: "http://127.0.0.1:5173",
    },
    agent: {
      provider: "mock",
      scopePolicy: "prefer-selection",
    },
  };

  await mkdir(configDirectory, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  io.log(`PatchLens initialized for ${framework}.`);
  io.log("Created .patchlens/config.json");
  io.log("Next: add the PatchLens Vite plugin and run `patchlens doctor`.");
  return 0;
}

async function runDoctor(projectRoot: string, io: CliIO): Promise<number> {
  const packagePath = path.join(projectRoot, "package.json");
  const projectPackage = await readProjectPackage(packagePath);
  const configPath = path.join(projectRoot, ".patchlens", "config.json");

  io.log("PatchLens doctor");
  io.log(`  Node.js: ${process.version}`);
  io.log(`  Project: ${projectPackage ? "found" : "missing package.json"}`);
  io.log(`  Framework: ${projectPackage ? detectFramework(projectPackage) : "unknown"}`);
  io.log(`  Config: ${(await exists(configPath)) ? "found" : "not initialized"}`);

  try {
    const response = await fetch("http://127.0.0.1:4311/api/health", {
      signal: AbortSignal.timeout(700),
    });
    io.log(`  Daemon: ${response.ok ? "online" : `HTTP ${response.status}`}`);
  } catch {
    io.log("  Daemon: offline");
  }

  return projectPackage ? 0 : 1;
}

async function readProjectPackage(file: string): Promise<ProjectPackage | undefined> {
  try {
    const content = await readFile(file, "utf8");
    return JSON.parse(content) as ProjectPackage;
  } catch {
    return undefined;
  }
}

function detectFramework(projectPackage: ProjectPackage): string {
  const dependencies = {
    ...projectPackage.dependencies,
    ...projectPackage.devDependencies,
  };

  if (dependencies.next) {
    return "next";
  }

  if (dependencies.vite && dependencies.react) {
    return "react-vite";
  }

  if (dependencies.vite) {
    return "vite";
  }

  return "unknown";
}

function inferDevCommand(projectPackage: ProjectPackage): string {
  return projectPackage.scripts?.dev ? "npm run dev" : "npm start";
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function printHelp(io: CliIO): void {
  io.log("PatchLens AI");
  io.log("");
  io.log("Usage: patchlens <command>");
  io.log("");
  io.log("Commands:");
  io.log("  init     Create a local PatchLens project configuration");
  io.log("  doctor   Check the project, framework and local daemon");
  io.log("  help     Show this help message");
}
