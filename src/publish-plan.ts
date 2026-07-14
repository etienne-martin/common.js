import { readFile } from "node:fs/promises";
import path from "node:path";
import { assert } from "@sindresorhus/is";
import semver from "semver";
import { PackageJson } from "type-fest";

type PublishPackageJson = PackageJson & {
  name: string;
  version: string;
  commonjs?: {
    buildKey?: string;
  };
};

export type PackageToPublish = {
  key: string;
  packagePath: string;
  packageJson: PublishPackageJson;
};

const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

export const getPackageVersionKey = (name: string, version: string) => `${name}@${version}`;

const getAliasedPackageKey = (dependencySpec: string) => {
  if (!dependencySpec.startsWith("npm:")) {
    return;
  }

  const aliasTarget = dependencySpec.slice("npm:".length);
  const versionSeparatorIndex = aliasTarget.lastIndexOf("@");

  if (versionSeparatorIndex <= 0) {
    return;
  }

  const packageName = aliasTarget.slice(0, versionSeparatorIndex);
  const packageVersion = aliasTarget.slice(versionSeparatorIndex + 1);

  if (!semver.valid(packageVersion)) {
    return;
  }

  return getPackageVersionKey(packageName, packageVersion);
};

const getConvertedDependencyKeys = (packageJson: PublishPackageJson) => {
  const dependencyKeys = new Set<string>();

  for (const field of DEPENDENCY_FIELDS) {
    for (const dependencySpec of Object.values(packageJson[field] ?? {})) {
      if (!dependencySpec) {
        continue;
      }

      const dependencyKey = getAliasedPackageKey(dependencySpec);

      if (dependencyKey) {
        dependencyKeys.add(dependencyKey);
      }
    }
  }

  return [...dependencyKeys].sort();
};

const readPackageToPublish = async (packageJsonPath: string): Promise<PackageToPublish> => {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJson;

  assert.string(packageJson.name);
  assert.string(packageJson.version);

  return {
    key: getPackageVersionKey(packageJson.name, packageJson.version),
    packagePath: path.dirname(packageJsonPath),
    packageJson: packageJson as PublishPackageJson
  };
};

export const orderPackagesForPublishing = async (
  packageJsonPaths: readonly string[]
): Promise<PackageToPublish[]> => {
  const packagesByKey = new Map<string, PackageToPublish>();

  for (const packageToPublish of await Promise.all(packageJsonPaths.map(readPackageToPublish))) {
    const existingPackage = packagesByKey.get(packageToPublish.key);

    if (!existingPackage) {
      packagesByKey.set(packageToPublish.key, packageToPublish);
      continue;
    }

    if (
      !existingPackage.packageJson.commonjs?.buildKey ||
      existingPackage.packageJson.commonjs.buildKey !== packageToPublish.packageJson.commonjs?.buildKey
    ) {
      throw new Error(`Conflicting generated packages for ${packageToPublish.key}`);
    }
  }

  const orderedPackages: PackageToPublish[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (packageToPublish: PackageToPublish, ancestors: readonly string[]): void => {
    if (visited.has(packageToPublish.key)) {
      return;
    }

    if (visiting.has(packageToPublish.key)) {
      throw new Error(
        `Circular converted package dependencies: ${[...ancestors, packageToPublish.key].join(" -> ")}`
      );
    }

    visiting.add(packageToPublish.key);

    for (const dependencyKey of getConvertedDependencyKeys(packageToPublish.packageJson)) {
      const dependency = packagesByKey.get(dependencyKey);

      if (dependency) {
        visit(dependency, [...ancestors, packageToPublish.key]);
      }
    }

    visiting.delete(packageToPublish.key);
    visited.add(packageToPublish.key);
    orderedPackages.push(packageToPublish);
  };

  for (const packageToPublish of [...packagesByKey.values()].sort((left, right) => (
    left.key.localeCompare(right.key)
  ))) {
    visit(packageToPublish, []);
  }

  return orderedPackages;
};
