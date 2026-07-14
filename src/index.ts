import { writeFile, rm, mkdir, cp } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { PackageJson } from "type-fest";
import is, {  assert } from "@sindresorhus/is";
import { glob } from "./utils/glob";
import { replaceReadme } from "./readme";
import { escapePackageName } from "./package-name";
import { publishPackage } from "./publish";
import { installDeps } from "./install";
import { transpilePackage } from "./transpile";

const TEMP_FOLDER = path.resolve("./tmp");

type PackageEntrypoints = Pick<PackageJson, "browser" | "main" | "types">;

const SUPPORTED_LICENSES = ["BSD-3-CLAUSE", "MIT"];

const isSupportedLicense = (license: string | undefined) => (
  !!license && SUPPORTED_LICENSES.some((supportedLicense) => license.includes(supportedLicense))
);

const hasRootExport = (exports: PackageJson["exports"]) => {
  if (!is.object(exports)) {
    return true;
  }

  const exportKeys = Object.keys(exports);
  return exportKeys.includes(".") || exportKeys.every((key) => !key.startsWith("."));
}

const getRootExport = (exports: PackageJson["exports"]) => {
  if (!is.object(exports)) {
    return exports;
  }

  const exportMap = exports as Record<string, unknown>;
  if ("." in exportMap) {
    return exportMap["."];
  }

  return hasRootExport(exports) ? exports : undefined;
}

const getEntrypointsFromExport = (exportValue: unknown): PackageEntrypoints => {
  const entrypoints: PackageEntrypoints = {};

  if (is.string(exportValue)) {
    entrypoints.main = exportValue;
    return entrypoints;
  }

  if (!is.object(exportValue)) {
    return entrypoints;
  }

  const conditions = exportValue as Record<string, unknown>;
  const browserEntrypoint = conditions["browser"];
  const defaultEntrypoint = conditions["default"];
  const importEntrypoint = conditions["import"];
  const nodeEntrypoint = conditions["node"];
  const requireEntrypoint = conditions["require"];
  const typesEntrypoint = conditions["types"];

  if (is.string(typesEntrypoint)) {
    entrypoints.types = typesEntrypoint;
  }

  if (is.string(defaultEntrypoint)) {
    entrypoints.main = defaultEntrypoint;
  }

  if (is.string(importEntrypoint) && !entrypoints.main) {
    entrypoints.main = importEntrypoint;
  }

  if (is.string(requireEntrypoint)) {
    entrypoints.main = requireEntrypoint;
  }

  if (is.string(nodeEntrypoint)) {
    entrypoints.main = nodeEntrypoint;

    if (is.string(defaultEntrypoint)) {
      entrypoints.browser = defaultEntrypoint;
    }
  }

  if (is.string(browserEntrypoint)) {
    entrypoints.browser = browserEntrypoint;

    if (is.string(defaultEntrypoint)) {
      entrypoints.main = defaultEntrypoint;
    }
  }

  return entrypoints;
}

const getPackageEntrypoints = (exports: PackageJson["exports"]): PackageEntrypoints => {
  return getEntrypointsFromExport(getRootExport(exports));
}

const convertPackageJsonToCommonJs = async (packageJson: PackageJson, esmModules: Record<string, string[]>) => {
  assert.string(packageJson.name);

  // @ts-ignore
  const newPackageJson: PackageJson = {
    ...packageJson,
    name: `@common.js/${escapePackageName(packageJson.name)}`,
    repository: "etienne-martin/common.js",
    homepage: "https://github.com/etienne-martin/common.js#readme",
    type: "commonjs",
    description: `${packageJson.name} package exported as CommonJS modules`,
    exports: undefined,
    module: undefined,
    keywords: undefined,
    author: undefined,
    dependencies: {},
    scripts: {
      ...packageJson.scripts,
      postpack: undefined,
      postpublish: undefined,
      prepare: undefined,
      prepublish: undefined,
      prepack: undefined,
      prepublishOnly: undefined,
      publish: undefined
    }
  }

  const license = packageJson.license?.toUpperCase();
  if (!isSupportedLicense(license)) {
    throw new Error(`Unsupported license: ${packageJson.license}`);
  }

  // https://nodejs.org/api/packages.html#community-conditions-definitions
  if (packageJson.exports) {
    const entrypoints = getPackageEntrypoints(packageJson.exports);

    newPackageJson.browser = entrypoints.browser ?? newPackageJson.browser;
    newPackageJson.main = entrypoints.main ?? newPackageJson.main;
    newPackageJson.types = entrypoints.types ?? newPackageJson.types;

    // Makes sure that we've managed to convert the entry point
    if (hasRootExport(packageJson.exports) && !newPackageJson.types) {
      assert.string(newPackageJson.main);
    }
  }

  if (is.object(packageJson.dependencies)) {
    for (const [name, range] of Object.entries(packageJson.dependencies)) {
      assert.string(range);
      const needsCommonJsVersion = esmModules[name]?.some((version) => semver.satisfies(version, range)) ?? false;

      if (needsCommonJsVersion) {
        // @ts-ignore
        newPackageJson.dependencies[`@common.js/${escapePackageName(name)}`] = range;
      } else {
        // @ts-ignore
        newPackageJson.dependencies[name] = range;
      }
    }
  }

  return newPackageJson;
}

const isEsmOnly = (packageJson: PackageJson) => {
  if (packageJson.type !== "module") {
    return false;
  }

  const hasCommonJsMain = is.string(packageJson.main) && packageJson.main.endsWith(".cjs");
  const rootExport = getRootExport(packageJson.exports);

  if (!is.object(rootExport)) {
    return !hasCommonJsMain;
  }

  const requireEntrypoint = (rootExport as Record<string, unknown>)["require"];
  return !hasCommonJsMain && !requireEntrypoint;
}

const parsePinnedPackage = (pinnedPackage: string) => {
  const versionSeparatorIndex = pinnedPackage.lastIndexOf("@");

  if (versionSeparatorIndex <= 0) {
    throw new Error(`Invalid pinned package: ${pinnedPackage}`);
  }

  return {
    packageName: pinnedPackage.slice(0, versionSeparatorIndex),
    packageVersion: pinnedPackage.slice(versionSeparatorIndex + 1)
  };
}

const convert = async (pinnedPackage: string) => {
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

  const packages = (await Promise.all([
    await glob(path.resolve(packageDir, "**/node_modules/*/package.json"), {}),
    await glob(path.resolve(packageDir, "**/node_modules/\@*/*/package.json"), {}),
  ])).flat();

  const esmModules = packages.reduce<Record<string, string[]>>((acc, packageJsonPath) => {
    const packageJson: PackageJson = require(packageJsonPath);

    assert.string(packageJson.name);
    assert.string(packageJson.version);

    if (isEsmOnly(packageJson)) {
      acc[packageJson.name] ??= [];
      acc[packageJson.name]?.push(packageJson.version);
    }

    return acc;
  }, {});

  if (!Object.keys(esmModules).length) {
    console.log(`Nothing to convert, ${packageName} is already exported as CommonJS modules`);
    return;
  }

  console.log(`Found ${Object.keys(esmModules).length} ESM packages to convert:`);
  Object.entries(esmModules).forEach((entry) => console.log(" ", ...entry));

  for (const packageJsonPath of packages) {
    const packagePath = path.dirname(packageJsonPath);
    const packageJson: PackageJson = require(packageJsonPath);

    if (!isEsmOnly(packageJson)) {
      await rm(path.dirname(packageJsonPath), { recursive: true, force: true });
      continue;
    }

    console.time(`Converted ${packageJson.name} entrypoints to CommonJS`);

    await writeFile(
      packageJsonPath,
      JSON.stringify(
        await convertPackageJsonToCommonJs(packageJson, esmModules),
        null,
        2
      )
    );

    await replaceReadme(packagePath);

    console.timeEnd(`Converted ${packageJson.name} entrypoints to CommonJS`);
  }

  console.time("Transpiled packages");

  await cp(
    path.resolve(packageDir, "node_modules"),
    path.resolve(TEMP_FOLDER, "./transpiled", pinnedPackage, "node_modules"),
    { recursive: true }
  );

  await transpilePackage(
    path.resolve(packageDir, "node_modules"),
    path.resolve(TEMP_FOLDER, "./transpiled"),
    esmModules
  );

  console.timeEnd("Transpiled packages");
  console.time("Published packages");

  const packagesToPublish = (await Promise.all([
    await glob(path.resolve(TEMP_FOLDER, "./transpiled", "**/node_modules/*/package.json"), {}),
    await glob(path.resolve(TEMP_FOLDER, "./transpiled", "**/node_modules/\@*/*/package.json"), {}),
  ])).flat();

  for (const packageToPublish of packagesToPublish) {
    await publishPackage(path.dirname(packageToPublish));
  }

  console.timeEnd("Published packages");
}

(async () => {
  for (const pinnedPackage of require("./esm-packages.json")) {
    await convert(pinnedPackage);
    console.log("---");
  }
})();
