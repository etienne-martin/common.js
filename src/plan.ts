import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { assert } from "@sindresorhus/is";
import semver from "semver";
import { PackageJson } from "type-fest";
import { isEsmOnly } from "./package-json";
import {
  TRANSFORM_REVISION,
  PublishedCommonJsVersions,
  allocateCommonJsVersion,
  getCommonJsPackageName,
  getPublishedCommonJsVersions
} from "./version";

export type InstalledPackageJson = PackageJson & {
  name: string;
  version: string;
};

export type InstalledPackage = {
  packageJsonPath: string;
  packagePath: string;
  packageJson: InstalledPackageJson;
};

export type PackageConversionPlan = {
  installedPackage: InstalledPackage;
  commonJsPackageName: string;
  commonJsVersion: string;
  publishTag?: string;
  buildKey: string;
  convertedDependencies: Map<string, PackageConversionPlan>;
};

type ConversionCandidate = {
  installedPackage: InstalledPackage;
  commonJsPackageName: string;
  commonJsVersion?: string;
  publishTag?: string;
  contentKey: string;
  buildKey: string;
  convertedDependencies: Map<string, ConversionCandidate>;
};

export type PublishedVersionsProvider = (
  sourcePackageName: string
) => Promise<PublishedCommonJsVersions>;

export type ConversionPlanOptions = {
  useProcessOverlay?: boolean;
};

const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;
const plannedVersionsByCommonJsName = new Map<string, PublishedCommonJsVersions>();

const getRuntimeDependencyNames = (packageJson: InstalledPackageJson) => {
  const dependencyNames = new Set<string>();

  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = packageJson[field];

    if (!dependencies) {
      continue;
    }

    Object.keys(dependencies).forEach((dependencyName) => dependencyNames.add(dependencyName));
  }

  return dependencyNames;
};

const findInstalledDependency = (
  installedPackage: InstalledPackage,
  dependencyName: string,
  installedPackagesByPath: ReadonlyMap<string, InstalledPackage>
) => {
  const requireFromPackage = createRequire(installedPackage.packageJsonPath);
  const searchPaths = requireFromPackage.resolve.paths(dependencyName) ?? [];

  for (const searchPath of searchPaths) {
    const dependencyPackageJsonPath = path.resolve(searchPath, dependencyName, "package.json");
    const dependencyPackage = installedPackagesByPath.get(dependencyPackageJsonPath);

    if (dependencyPackage) {
      return dependencyPackage;
    }
  }
};

const getCandidateContentKey = (
  candidate: ConversionCandidate,
  ancestors: ReadonlySet<string>
): string => {
  const sourcePackage = candidate.installedPackage.packageJson;
  const packageJsonPath = candidate.installedPackage.packageJsonPath;

  if (ancestors.has(packageJsonPath)) {
    return `cycle:${sourcePackage.name}@${sourcePackage.version}`;
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(packageJsonPath);

  const dependencies = [...candidate.convertedDependencies.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dependencyName, dependency]) => ({
      dependencyName,
      sourceName: dependency.installedPackage.packageJson.name,
      sourceVersion: dependency.installedPackage.packageJson.version,
      contentKey: getCandidateContentKey(dependency, nextAncestors)
    }));

  return createHash("sha256")
    .update(JSON.stringify({
      source: {
        name: sourcePackage.name,
        version: sourcePackage.version
      },
      transformRevision: TRANSFORM_REVISION,
      dependencies
    }))
    .digest("hex");
};

const sortCandidates = (left: ConversionCandidate, right: ConversionCandidate) => {
  const leftPackage = left.installedPackage.packageJson;
  const rightPackage = right.installedPackage.packageJson;

  return semver.compare(leftPackage.version, rightPackage.version) ||
    left.contentKey.localeCompare(right.contentKey) ||
    left.installedPackage.packageJsonPath.localeCompare(right.installedPackage.packageJsonPath);
};

const getCandidateBuildKey = (candidate: ConversionCandidate) => {
  const dependencies = [...candidate.convertedDependencies.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dependencyName, dependency]) => {
      assert.string(dependency.commonJsVersion);

      return {
        dependencyName,
        packageName: dependency.commonJsPackageName,
        version: dependency.commonJsVersion
      };
    });

  return createHash("sha256")
    .update(JSON.stringify({
      contentKey: candidate.contentKey,
      dependencies
    }))
    .digest("hex");
};

export const readInstalledPackages = async (packageJsonPaths: readonly string[]) => Promise.all(
  packageJsonPaths.map(async (packageJsonPath): Promise<InstalledPackage> => {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJson;

    assert.string(packageJson.name);
    assert.string(packageJson.version);

    const normalizedPackageJsonPath = path.resolve(packageJsonPath);

    return {
      packageJsonPath: normalizedPackageJsonPath,
      packagePath: path.dirname(normalizedPackageJsonPath),
      packageJson: packageJson as InstalledPackageJson
    };
  })
);

export const createConversionPlans = async (
  installedPackages: readonly InstalledPackage[],
  getPublishedVersions: PublishedVersionsProvider = getPublishedCommonJsVersions,
  options: ConversionPlanOptions = {}
): Promise<PackageConversionPlan[]> => {
  const useProcessOverlay = options.useProcessOverlay ?? (
    getPublishedVersions === getPublishedCommonJsVersions
  );
  const installedPackagesByPath = new Map(
    installedPackages.map((installedPackage) => [installedPackage.packageJsonPath, installedPackage])
  );
  const candidates = installedPackages
    .filter(({ packageJson }) => isEsmOnly(packageJson))
    .map((installedPackage): ConversionCandidate => ({
      installedPackage,
      commonJsPackageName: getCommonJsPackageName(installedPackage.packageJson.name),
      contentKey: "",
      buildKey: "",
      convertedDependencies: new Map()
    }));
  const candidatesByPath = new Map(
    candidates.map((candidate) => [candidate.installedPackage.packageJsonPath, candidate])
  );

  for (const candidate of candidates) {
    for (const dependencyName of getRuntimeDependencyNames(candidate.installedPackage.packageJson)) {
      const installedDependency = findInstalledDependency(
        candidate.installedPackage,
        dependencyName,
        installedPackagesByPath
      );
      const dependencyCandidate = installedDependency
        ? candidatesByPath.get(installedDependency.packageJsonPath)
        : undefined;

      if (dependencyCandidate) {
        candidate.convertedDependencies.set(dependencyName, dependencyCandidate);
      }
    }
  }

  for (const candidate of candidates) {
    candidate.contentKey = getCandidateContentKey(candidate, new Set());
  }

  const candidatesByCommonJsName = new Map<string, ConversionCandidate[]>();

  for (const candidate of candidates) {
    const sourceCandidates = candidatesByCommonJsName.get(candidate.commonJsPackageName) ?? [];
    sourceCandidates.push(candidate);
    candidatesByCommonJsName.set(candidate.commonJsPackageName, sourceCandidates);
  }

  const allocationStates = new Map<string, {
    publishedVersions: PublishedCommonJsVersions;
    reservedVersions: Set<string>;
    allocatedVersionsByBuild: Map<string, string>;
  }>();

  await Promise.all([...candidatesByCommonJsName.entries()].map(async ([commonJsName, sourceCandidates]) => {
    const sourceName = sourceCandidates[0]?.installedPackage.packageJson.name;

    assert.string(sourceName);
    const publishedVersions = await getPublishedVersions(sourceName);
    const plannedVersions = useProcessOverlay
      ? plannedVersionsByCommonJsName.get(commonJsName) ?? {}
      : {};

    allocationStates.set(commonJsName, {
      publishedVersions: {
        ...publishedVersions,
        ...plannedVersions
      },
      reservedVersions: new Set(),
      allocatedVersionsByBuild: new Map()
    });
  }));

  const visiting = new Set<ConversionCandidate>();
  const visited = new Set<ConversionCandidate>();

  const allocateCandidate = (
    candidate: ConversionCandidate,
    ancestors: readonly ConversionCandidate[]
  ): void => {
    if (visited.has(candidate)) {
      return;
    }

    if (visiting.has(candidate)) {
      const cycle = [...ancestors, candidate]
        .map(({ installedPackage }) => (
          `${installedPackage.packageJson.name}@${installedPackage.packageJson.version}`
        ))
        .join(" -> ");

      throw new Error(`Circular converted package dependencies cannot be published safely: ${cycle}`);
    }

    visiting.add(candidate);

    for (const [, dependency] of [...candidate.convertedDependencies.entries()].sort(
      ([left], [right]) => left.localeCompare(right)
    )) {
      allocateCandidate(dependency, [...ancestors, candidate]);
    }

    const allocationState = allocationStates.get(candidate.commonJsPackageName);

    if (!allocationState) {
      throw new Error(`Missing version allocation state for ${candidate.commonJsPackageName}`);
    }

    candidate.buildKey = getCandidateBuildKey(candidate);
    const sourceVersion = candidate.installedPackage.packageJson.version;
    const allocationKey = `${sourceVersion}:${candidate.buildKey}`;
    const existingAllocation = allocationState.allocatedVersionsByBuild.get(allocationKey);

    if (existingAllocation) {
      candidate.commonJsVersion = existingAllocation;
    } else {
      const commonJsVersion = allocateCommonJsVersion(
        sourceVersion,
        candidate.buildKey,
        allocationState.publishedVersions,
        allocationState.reservedVersions
      );

      candidate.commonJsVersion = commonJsVersion;
      allocationState.reservedVersions.add(commonJsVersion);
      allocationState.allocatedVersionsByBuild.set(allocationKey, commonJsVersion);
    }

    visiting.delete(candidate);
    visited.add(candidate);
  };

  for (const candidate of [...candidates].sort((left, right) => (
    left.commonJsPackageName.localeCompare(right.commonJsPackageName) || sortCandidates(left, right)
  ))) {
    allocateCandidate(candidate, []);
  }

  for (const [commonJsName, sourceCandidates] of candidatesByCommonJsName) {
    const allocationState = allocationStates.get(commonJsName);

    if (!allocationState) {
      throw new Error(`Missing version allocation state for ${commonJsName}`);
    }

    const { publishedVersions } = allocationState;

    const knownReleases = [
      ...Object.entries(publishedVersions).flatMap(([registryVersion, publishedVersion]) => {
        if (publishedVersion.unpublished) {
          return [];
        }

        const commonJsVersion = semver.valid(publishedVersion.version)
          ? publishedVersion.version
          : registryVersion;
        const sourceVersion = publishedVersion.commonjs?.source.version ?? commonJsVersion;

        return semver.valid(commonJsVersion) && semver.valid(sourceVersion)
          ? [{ commonJsVersion, sourceVersion }]
          : [];
      }),
      ...sourceCandidates.flatMap((candidate) => {
        const commonJsVersion = candidate.commonJsVersion;
        const sourceVersion = candidate.installedPackage.packageJson.version;

        return commonJsVersion && semver.valid(commonJsVersion) && semver.valid(sourceVersion)
          ? [{ commonJsVersion, sourceVersion }]
          : [];
      })
    ];

    for (const candidate of sourceCandidates) {
      const commonJsVersion = candidate.commonJsVersion;
      const sourceVersion = candidate.installedPackage.packageJson.version;

      assert.string(commonJsVersion);
      candidate.publishTag = knownReleases.some((release) => {
        const sourceComparison = semver.compare(release.sourceVersion, sourceVersion);

        return sourceComparison > 0 || (
          sourceComparison === 0 && semver.gt(release.commonJsVersion, commonJsVersion)
        );
      })
        ? "commonjs"
        : "latest";
    }
  }

  if (useProcessOverlay) {
    for (const candidate of candidates) {
      const sourcePackage = candidate.installedPackage.packageJson;

      assert.string(candidate.commonJsVersion);
      const plannedVersions = plannedVersionsByCommonJsName.get(candidate.commonJsPackageName) ?? {};
      plannedVersions[candidate.commonJsVersion] = {
        version: candidate.commonJsVersion,
        commonjs: {
          source: {
            name: sourcePackage.name,
            version: sourcePackage.version
          },
          transformRevision: TRANSFORM_REVISION,
          buildKey: candidate.buildKey
        }
      };
      plannedVersionsByCommonJsName.set(candidate.commonJsPackageName, plannedVersions);
    }
  }

  const plansByCandidate = new Map<ConversionCandidate, PackageConversionPlan>();

  for (const candidate of candidates) {
    assert.string(candidate.commonJsVersion);
    plansByCandidate.set(candidate, {
      installedPackage: candidate.installedPackage,
      commonJsPackageName: candidate.commonJsPackageName,
      commonJsVersion: candidate.commonJsVersion,
      publishTag: candidate.publishTag,
      buildKey: candidate.buildKey,
      convertedDependencies: new Map()
    });
  }

  for (const candidate of candidates) {
    const plan = plansByCandidate.get(candidate);

    if (!plan) {
      continue;
    }

    for (const [dependencyName, dependencyCandidate] of candidate.convertedDependencies) {
      const dependencyPlan = plansByCandidate.get(dependencyCandidate);

      if (dependencyPlan) {
        plan.convertedDependencies.set(dependencyName, dependencyPlan);
      }
    }
  }

  return candidates.map((candidate) => plansByCandidate.get(candidate) as PackageConversionPlan);
};
