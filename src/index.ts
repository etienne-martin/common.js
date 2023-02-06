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
      prepare: undefined,
      prepack: undefined,
      prepublishOnly: undefined
    }
  }

  if (packageJson.license?.toUpperCase() !== "MIT") {
    throw new Error(`Unsupported license: ${packageJson.license}`);
  }

  // https://nodejs.org/api/packages.html#community-conditions-definitions
  if (packageJson.exports) {
    if (is.string(packageJson.exports)) {
      newPackageJson.main = packageJson.exports;
    } else if (is.object(packageJson.exports)) {
      // @ts-ignore
      if ("types" in packageJson.exports && is.string(packageJson.exports.types)) {
        // @ts-ignore
        newPackageJson.types = packageJson.exports.types;
      }

      if ("node" in packageJson.exports && is.string(packageJson.exports.node)) {
        newPackageJson.main = packageJson.exports.node;

        if ("default" in packageJson.exports && is.string(packageJson.exports.default)) {
          newPackageJson.browser = packageJson.exports.default;
        }
      }

      if ("browser" in packageJson.exports && is.string(packageJson.exports.browser)) {
        newPackageJson.browser = packageJson.exports.browser;

        if ("default" in packageJson.exports && is.string(packageJson.exports.default)) {
          newPackageJson.main = packageJson.exports.default;
        }
      }
    }

    // Makes sure that we've managed to convert the entry point
    assert.string(newPackageJson.main);
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
  const isCjs = !packageJson.type || packageJson.type === "commonjs" || !!packageJson.main;
  const isEsm = packageJson.type === "module";

  return isEsm && !isCjs;
}

const convert = async (pinnedPackage: string) => {
  const [packageName, packageVersion] = pinnedPackage.split("@");
  const packageDir = path.resolve(TEMP_FOLDER, pinnedPackage);

  assert.string(packageName);
  assert.string(packageVersion);

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
    path.resolve(TEMP_FOLDER, "./transpiled")
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