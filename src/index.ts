import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PackageJson } from "type-fest";
import { installDeps } from "./install";
import { ConvertedDependency, convertPackageJsonToCommonJs } from "./package-json";
import { createConversionPlans, readInstalledPackages } from "./plan";
import { publishPackage } from "./publish";
import { getPackageVersionKey, orderPackagesForPublishing } from "./publish-plan";
import { replaceReadme } from "./readme";
import { rewritePackageSelfReferences, transpilePackage } from "./transpile";
import { glob } from "./utils/glob";

const TEMP_FOLDER = path.resolve("./tmp");

export const parsePinnedPackage = (pinnedPackage: string) => {
  const versionSeparatorIndex = pinnedPackage.lastIndexOf("@");

  if (versionSeparatorIndex <= 0) {
    throw new Error(`Invalid pinned package: ${pinnedPackage}`);
  }

  return {
    packageName: pinnedPackage.slice(0, versionSeparatorIndex),
    packageVersion: pinnedPackage.slice(versionSeparatorIndex + 1)
  };
};

const getInstalledPackageJsonPaths = async (packageDir: string) => (
  await Promise.all([
    glob(path.resolve(packageDir, "**/node_modules/*/package.json"), {}),
    glob(path.resolve(packageDir, "**/node_modules/\@*/*/package.json"), {})
  ])
).flat();

export const convert = async (pinnedPackage: string) => {
  const { packageName, packageVersion } = parsePinnedPackage(pinnedPackage);
  const packageDir = path.resolve(TEMP_FOLDER, pinnedPackage);

  await rm(TEMP_FOLDER, { recursive: true, force: true });
  await mkdir(packageDir, { recursive: true });

  await writeFile(
    path.resolve(packageDir, "package.json"),
    JSON.stringify({
      dependencies: {
        [packageName]: packageVersion
      }
    }, null, 2)
  );

  await installDeps(packageDir);

  const installedPackages = await readInstalledPackages(
    await getInstalledPackageJsonPaths(packageDir)
  );
  const conversionPlans = await createConversionPlans(installedPackages);

  if (!conversionPlans.length) {
    console.log(`Nothing to convert, ${packageName} is already exported as CommonJS modules`);
    return;
  }

  console.log(`Found ${conversionPlans.length} ESM package installations to convert:`);
  conversionPlans.forEach((plan) => {
    const sourcePackage = plan.installedPackage.packageJson;
    console.log(
      " ",
      `${sourcePackage.name}@${sourcePackage.version}`,
      "->",
      `${plan.commonJsPackageName}@${plan.commonJsVersion}`
    );
  });

  const conversionPlansByPath = new Map(
    conversionPlans.map((plan) => [plan.installedPackage.packageJsonPath, plan])
  );

  for (const plan of conversionPlans) {
    const { installedPackage } = plan;
    const sourcePackage = installedPackage.packageJson;
    const convertedDependencies = new Map<string, ConvertedDependency>(
      [...plan.convertedDependencies.entries()].map(([dependencyName, dependencyPlan]) => [
        dependencyName,
        {
          packageName: dependencyPlan.commonJsPackageName,
          version: dependencyPlan.commonJsVersion
        }
      ])
    );

    console.time(`Converted ${sourcePackage.name} entrypoints to CommonJS`);

    await rewritePackageSelfReferences(
      installedPackage.packagePath,
      sourcePackage.name,
      plan.commonJsPackageName
    );

    const commonJsPackageJson: PackageJson = convertPackageJsonToCommonJs(
      sourcePackage,
      plan.commonJsVersion,
      plan.buildKey,
      convertedDependencies
    );

    await writeFile(
      installedPackage.packageJsonPath,
      JSON.stringify(commonJsPackageJson, null, 2)
    );
    await replaceReadme(
      installedPackage.packagePath,
      {
        name: sourcePackage.name,
        version: sourcePackage.version
      },
      plan.commonJsPackageName
    );

    console.timeEnd(`Converted ${sourcePackage.name} entrypoints to CommonJS`);
  }

  const packagesToRemove = installedPackages
    .filter(({ packageJsonPath }) => !conversionPlansByPath.has(packageJsonPath))
    .sort((left, right) => right.packagePath.length - left.packagePath.length);

  for (const installedPackage of packagesToRemove) {
    await rm(installedPackage.packagePath, { recursive: true, force: true });
  }

  console.time("Transpiled packages");

  await cp(
    path.resolve(packageDir, "node_modules"),
    path.resolve(TEMP_FOLDER, "./transpiled", pinnedPackage, "node_modules"),
    { recursive: true }
  );

  await transpilePackage(
    path.resolve(packageDir, "node_modules"),
    path.resolve(TEMP_FOLDER, "./transpiled")
  );

  console.timeEnd("Transpiled packages");
  console.time("Published packages");

  const packageJsonPathsToPublish = (await Promise.all([
    glob(path.resolve(TEMP_FOLDER, "./transpiled", "**/node_modules/*/package.json"), {}),
    glob(path.resolve(TEMP_FOLDER, "./transpiled", "**/node_modules/\@*/*/package.json"), {})
  ])).flat();
  const packagesToPublish = await orderPackagesForPublishing(packageJsonPathsToPublish);
  const publishTagsByPackage = new Map(conversionPlans.map((plan) => [
    getPackageVersionKey(plan.commonJsPackageName, plan.commonJsVersion),
    plan.publishTag
  ]));

  for (const packageToPublish of packagesToPublish) {
    await publishPackage(
      packageToPublish.packagePath,
      { tag: publishTagsByPackage.get(packageToPublish.key) }
    );
  }

  console.timeEnd("Published packages");
};

export const main = async () => {
  for (const pinnedPackage of require("./esm-packages.json") as string[]) {
    await convert(pinnedPackage);
    console.log("---");
  }
};

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
