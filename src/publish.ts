import { PackageJson } from "type-fest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { exec } from "./utils/exec";

const DRY_RUN = process.env.DISABLE_DRY_RUN !== "true";

export type PublishCommand = (command: string) => Promise<{
  stdout: string;
  stderr: string;
}>;

export type PublishOptions = {
  tag?: string;
  runCommand?: PublishCommand;
  dryRun?: boolean;
};

type CommonJsPackageJson = PackageJson & {
  commonjs?: {
    buildKey?: string;
  };
};

const completedBuilds = new Map<string, string>();
const completedTags = new Map<string, Set<string>>();

const getPackageVersionKey = (name: string, version: string) => `${name}@${version}`;

const markTagCompleted = (packageVersionKey: string, tag: string | undefined) => {
  if (!tag) {
    return;
  }

  const tags = completedTags.get(packageVersionKey) ?? new Set<string>();
  tags.add(tag);
  completedTags.set(packageVersionKey, tags);
};

const ensurePublishTag = async (
  name: string,
  version: string,
  tag: string | undefined,
  dryRun: boolean,
  runCommand: PublishCommand
) => {
  if (!tag) {
    return;
  }

  const packageVersionKey = getPackageVersionKey(name, version);

  if (completedTags.get(packageVersionKey)?.has(tag)) {
    return;
  }

  if (dryRun) {
    return;
  }

  await runCommand(
    `npm dist-tag add "${name}@${version}" "${tag}" --registry=https://registry.npmjs.org`
  );
  markTagCompleted(packageVersionKey, tag);
};

const getPublishedBuildKey = async (
  name: string,
  version: string,
  runCommand: PublishCommand
) => {
  const { stdout } = await runCommand(
    `npm view "${name}@${version}" commonjs.buildKey --json --registry=https://registry.npmjs.org`
  );
  const output = stdout.trim();

  return output ? JSON.parse(output) as unknown : undefined;
};

export const publishPackage = async (
  packagePath: string,
  options: PublishOptions = {}
) => {
  const packageJson = JSON.parse(
    await readFile(path.resolve(packagePath, "package.json"), "utf8")
  ) as CommonJsPackageJson;
  const runCommand = options.runCommand ?? exec;
  const dryRun = options.dryRun ?? DRY_RUN;
  const tagArg = options.tag ? `--tag "${options.tag}"` : "";
  const dryRunArg = dryRun ? "--dry-run" : "";
  const timerLabel = `Publishing ${packageJson.name}@${packageJson.version}`;
  const name = packageJson.name;
  const version = packageJson.version;
  const buildKey = packageJson.commonjs?.buildKey;

  if (!name || !version) {
    throw new Error(`Cannot publish a package without a name and version from ${packagePath}`);
  }

  const packageVersionKey = getPackageVersionKey(name, version);
  const completedBuildKey = completedBuilds.get(packageVersionKey);

  if (completedBuildKey) {
    if (completedBuildKey !== buildKey) {
      throw new Error(
        `${name}@${version} was already generated with different contents during this run`
      );
    }

    await ensurePublishTag(name, version, options.tag, dryRun, runCommand);
    console.log(`${name}@${version} is already handled`);
    return;
  }

  console.time(timerLabel);
  try {
    await runCommand(
      `cd "${packagePath}" && npm publish --registry=https://registry.npmjs.org --access public ${tagArg} ${dryRunArg}`
    );
    console.timeEnd(timerLabel);

    if (buildKey && !dryRun) {
      completedBuilds.set(packageVersionKey, buildKey);
    }

    if (!dryRun) {
      markTagCompleted(packageVersionKey, options.tag);
    }
  } catch (error) {
    console.timeEnd(timerLabel);

    if (!buildKey) {
      throw error;
    }

    let publishedBuildKey: unknown;

    try {
      publishedBuildKey = await getPublishedBuildKey(name, version, runCommand);
    } catch {
      throw error;
    }

    if (publishedBuildKey === buildKey) {
      completedBuilds.set(packageVersionKey, buildKey);
      await ensurePublishTag(name, version, options.tag, dryRun, runCommand);
      console.log(`${name}@${version} is already published`);
      return;
    }

    throw new Error(
      `${name}@${version} is already published with different generated contents`
    );
  }
};
