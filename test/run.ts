import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { PackageJson } from "type-fest";
import {
  ConvertedDependency,
  convertPackageJsonToCommonJs,
  isEsmOnly,
  transformPackageExports
} from "../src/package-json";
import {
  PackageConversionPlan,
  createConversionPlans,
  readInstalledPackages
} from "../src/plan";
import { publishPackage } from "../src/publish";
import { orderPackagesForPublishing } from "../src/publish-plan";
import {
  rewritePackageSelfReference,
  rewritePackageSelfReferences
} from "../src/transpile";
import {
  PublishedCommonJsVersions,
  TRANSFORM_REVISION,
  allocateCommonJsVersion,
  parsePublishedCommonJsVersions
} from "../src/version";

type Test = {
  name: string;
  run: () => void | Promise<void>;
};

const tests: Test[] = [];

const test = (name: string, run: Test["run"]) => {
  tests.push({ name, run });
};

const withTemporaryDirectory = async <T>(
  prefix: string,
  callback: (directory: string) => Promise<T>
) => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));

  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const writeText = async (filePath: string, contents: string) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
};

const writeJson = async (filePath: string, value: unknown) => {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const getPlan = (
  plans: readonly PackageConversionPlan[],
  packageName: string
) => {
  const plan = plans.find(({ installedPackage }) => (
    installedPackage.packageJson.name === packageName
  ));

  assert.ok(plan, `Expected a conversion plan for ${packageName}`);
  return plan;
};

const getConvertedDependencies = (plan: PackageConversionPlan) => (
  new Map<string, ConvertedDependency>(
    [...plan.convertedDependencies.entries()].map(([dependencyName, dependencyPlan]) => [
      dependencyName,
      {
        packageName: dependencyPlan.commonJsPackageName,
        version: dependencyPlan.commonJsVersion
      }
    ])
  )
);

test("allocates a new patch over an occupied legacy version and reuses a matching build", () => {
  const sourceVersion = "8.0.0";
  const buildKey = "same-generated-contents";
  const legacyVersions: PublishedCommonJsVersions = {
    "8.0.0": {
      version: "8.0.0"
    }
  };

  assert.equal(
    allocateCommonJsVersion(sourceVersion, buildKey, legacyVersions),
    "8.0.1"
  );

  const publishedVersions: PublishedCommonJsVersions = {
    ...legacyVersions,
    "8.0.1": {
      version: "8.0.1",
      commonjs: {
        source: {
          name: "p-retry",
          version: sourceVersion
        },
        transformRevision: TRANSFORM_REVISION,
        buildKey
      }
    }
  };

  assert.equal(
    allocateCommonJsVersion(sourceVersion, buildKey, publishedVersions),
    "8.0.1"
  );
  assert.equal(
    allocateCommonJsVersion(sourceVersion, "changed-generated-contents", publishedVersions),
    "8.0.2"
  );
  assert.equal(
    allocateCommonJsVersion("9.0.0", "new-package", {}),
    "9.0.0"
  );
});

test("reserves unpublished registry versions retained as time tombstones", () => {
  const publishedVersions = parsePublishedCommonJsVersions({
    versions: {
      "1.0.0": {
        version: "1.0.0"
      }
    },
    time: {
      created: "2020-01-01T00:00:00.000Z",
      modified: "2020-01-03T00:00:00.000Z",
      "1.0.0": "2020-01-01T00:00:00.000Z",
      "1.0.1": "2020-01-02T00:00:00.000Z"
    }
  });

  assert.deepEqual(publishedVersions["1.0.1"], {
    version: "1.0.1",
    unpublished: true
  });
  assert.equal(
    allocateCommonJsVersion("1.0.0", "new-build", publishedVersions),
    "1.0.2"
  );
});

test("plans converted dependencies from the version resolved by each importer", async () => {
  await withTemporaryDirectory("common-js-plan-", async (directory) => {
    const nodeModulesPath = path.join(directory, "node_modules");
    const esmDependencyPackageJsonPath = path.join(nodeModulesPath, "dep", "package.json");
    const modernParentPackageJsonPath = path.join(nodeModulesPath, "modern-parent", "package.json");
    const legacyParentPackageJsonPath = path.join(nodeModulesPath, "legacy-parent", "package.json");
    const modernParentEntryPath = path.join(nodeModulesPath, "modern-parent", "index.js");
    const legacyParentEntryPath = path.join(nodeModulesPath, "legacy-parent", "index.js");
    const cjsDependencyPackageJsonPath = path.join(
      nodeModulesPath,
      "legacy-parent",
      "node_modules",
      "dep",
      "package.json"
    );

    await Promise.all([
      writeJson(esmDependencyPackageJsonPath, {
        name: "dep",
        version: "2.0.0",
        type: "module",
        license: "MIT",
        exports: {
          import: "./index.js"
        }
      }),
      writeJson(cjsDependencyPackageJsonPath, {
        name: "dep",
        version: "1.0.0",
        type: "commonjs",
        license: "MIT",
        main: "./index.js"
      }),
      writeJson(modernParentPackageJsonPath, {
        name: "modern-parent",
        version: "1.0.0",
        type: "module",
        license: "MIT",
        main: "./index.js",
        dependencies: {
          dep: "^2.0.0"
        }
      }),
      writeJson(legacyParentPackageJsonPath, {
        name: "legacy-parent",
        version: "1.0.0",
        type: "module",
        license: "MIT",
        main: "./index.js",
        dependencies: {
          dep: "^1.0.0"
        }
      }),
      writeText(modernParentEntryPath, "module.exports = require(\"dep\");\n"),
      writeText(legacyParentEntryPath, "module.exports = require(\"dep\");\n")
    ]);

    const installedPackages = await readInstalledPackages([
      esmDependencyPackageJsonPath,
      cjsDependencyPackageJsonPath,
      modernParentPackageJsonPath,
      legacyParentPackageJsonPath
    ]);
    const registryRequests: string[] = [];
    const plans = await createConversionPlans(
      installedPackages,
      async (packageName) => {
        registryRequests.push(packageName);
        return {};
      }
    );

    assert.equal(plans.length, 3);
    assert.deepEqual(
      [...registryRequests].sort(),
      ["dep", "legacy-parent", "modern-parent"]
    );

    const dependencyPlan = getPlan(plans, "dep");
    const modernParentPlan = getPlan(plans, "modern-parent");
    const legacyParentPlan = getPlan(plans, "legacy-parent");

    assert.equal(dependencyPlan.installedPackage.packageJson.version, "2.0.0");
    assert.equal(legacyParentPlan.convertedDependencies.has("dep"), false);
    assert.equal(modernParentPlan.convertedDependencies.get("dep"), dependencyPlan);

    await Promise.all([
      rewritePackageSelfReferences(
        modernParentPlan.installedPackage.packagePath,
        "modern-parent",
        modernParentPlan.commonJsPackageName
      ),
      rewritePackageSelfReferences(
        legacyParentPlan.installedPackage.packagePath,
        "legacy-parent",
        legacyParentPlan.commonJsPackageName
      )
    ]);

    assert.equal(await readFile(modernParentEntryPath, "utf8"), "module.exports = require(\"dep\");\n");
    assert.equal(await readFile(legacyParentEntryPath, "utf8"), "module.exports = require(\"dep\");\n");

    const legacyPackageJson = convertPackageJsonToCommonJs(
      legacyParentPlan.installedPackage.packageJson,
      legacyParentPlan.commonJsVersion,
      legacyParentPlan.buildKey,
      getConvertedDependencies(legacyParentPlan)
    );
    const modernPackageJson = convertPackageJsonToCommonJs(
      modernParentPlan.installedPackage.packageJson,
      modernParentPlan.commonJsVersion,
      modernParentPlan.buildKey,
      getConvertedDependencies(modernParentPlan)
    );

    assert.deepEqual(legacyPackageJson.dependencies, {
      dep: "^1.0.0"
    });
    assert.deepEqual(modernPackageJson.dependencies, {
      dep: `npm:${dependencyPlan.commonJsPackageName}@${dependencyPlan.commonJsVersion}`
    });
  });
});

test("gives the same source release distinct builds for distinct resolved dependency graphs", async () => {
  await withTemporaryDirectory("common-js-build-identity-", async (directory) => {
    const packageJsonPaths: string[] = [];

    for (const [treeName, dependencyVersion] of [
      ["tree-a", "1.0.0"],
      ["tree-b", "2.0.0"]
    ] as const) {
      const treeNodeModules = path.join(directory, "node_modules", treeName, "node_modules");
      const dependencyPackageJsonPath = path.join(treeNodeModules, "dep", "package.json");
      const parentPackageJsonPath = path.join(treeNodeModules, "same-parent", "package.json");

      await Promise.all([
        writeJson(dependencyPackageJsonPath, {
          name: "dep",
          version: dependencyVersion,
          type: "module",
          license: "MIT",
          main: "./index.js"
        }),
        writeJson(parentPackageJsonPath, {
          name: "same-parent",
          version: "1.0.0",
          type: "module",
          license: "MIT",
          main: "./index.js",
          dependencies: {
            dep: dependencyVersion
          }
        })
      ]);
      packageJsonPaths.push(dependencyPackageJsonPath, parentPackageJsonPath);
    }

    const plans = await createConversionPlans(
      await readInstalledPackages(packageJsonPaths),
      async () => ({})
    );
    const parentPlans = plans.filter(({ installedPackage }) => (
      installedPackage.packageJson.name === "same-parent"
    ));

    assert.equal(parentPlans.length, 2);
    assert.notEqual(parentPlans[0]?.buildKey, parentPlans[1]?.buildKey);
    assert.notEqual(parentPlans[0]?.commonJsVersion, parentPlans[1]?.commonJsVersion);
    assert.notEqual(
      parentPlans[0]?.convertedDependencies.get("dep")?.installedPackage.packageJson.version,
      parentPlans[1]?.convertedDependencies.get("dep")?.installedPackage.packageJson.version
    );
    assert.deepEqual(
      parentPlans.map(({ commonJsVersion }) => commonJsVersion).sort(),
      ["1.0.0", "1.0.1"]
    );
    assert.equal(
      parentPlans.find(({ commonJsVersion }) => commonJsVersion === "1.0.0")?.publishTag,
      "commonjs"
    );
    assert.equal(
      parentPlans.find(({ commonJsVersion }) => commonJsVersion === "1.0.1")?.publishTag,
      "latest"
    );
  });
});

test("keeps planned releases across stale registry reads in later conversions", async () => {
  await withTemporaryDirectory("common-js-plan-overlay-", async (directory) => {
    const writeTree = async (treeName: string, dependencyVersion: string) => {
      const nodeModulesPath = path.join(directory, treeName, "node_modules");
      const dependencyPackageJsonPath = path.join(nodeModulesPath, "overlay-dep", "package.json");
      const parentPackageJsonPath = path.join(nodeModulesPath, "overlay-parent", "package.json");

      await Promise.all([
        writeJson(dependencyPackageJsonPath, {
          name: "overlay-dep",
          version: dependencyVersion,
          type: "module",
          license: "MIT",
          main: "./index.js"
        }),
        writeJson(parentPackageJsonPath, {
          name: "overlay-parent",
          version: "1.0.0",
          type: "module",
          license: "MIT",
          main: "./index.js",
          dependencies: {
            "overlay-dep": dependencyVersion
          }
        })
      ]);

      return readInstalledPackages([dependencyPackageJsonPath, parentPackageJsonPath]);
    };
    const staleRegistry = async () => ({});
    const firstPlans = await createConversionPlans(
      await writeTree("tree-one", "1.0.0"),
      staleRegistry,
      { useProcessOverlay: true }
    );
    const secondPlans = await createConversionPlans(
      await writeTree("tree-two", "2.0.0"),
      staleRegistry,
      { useProcessOverlay: true }
    );
    const firstParent = getPlan(firstPlans, "overlay-parent");
    const secondParent = getPlan(secondPlans, "overlay-parent");

    assert.equal(firstParent.commonJsVersion, "1.0.0");
    assert.equal(secondParent.commonJsVersion, "1.0.1");
    assert.notEqual(firstParent.buildKey, secondParent.buildKey);
  });
});

test("changes a parent release when an identical dependency build moves wrapper versions", async () => {
  await withTemporaryDirectory("common-js-dependency-reallocation-", async (directory) => {
    const nodeModulesPath = path.join(directory, "node_modules");
    const dependencyPath = path.join(nodeModulesPath, "moving-dep", "package.json");
    const parentPath = path.join(nodeModulesPath, "moving-parent", "package.json");

    await Promise.all([
      writeJson(dependencyPath, {
        name: "moving-dep",
        version: "1.0.0",
        type: "module",
        license: "MIT",
        main: "./index.js"
      }),
      writeJson(parentPath, {
        name: "moving-parent",
        version: "1.0.0",
        type: "module",
        license: "MIT",
        main: "./index.js",
        dependencies: {
          "moving-dep": "1.0.0"
        }
      })
    ]);

    const installedPackages = await readInstalledPackages([dependencyPath, parentPath]);
    const firstPlans = await createConversionPlans(installedPackages, async () => ({}));
    const firstParent = getPlan(firstPlans, "moving-parent");
    const secondPlans = await createConversionPlans(
      installedPackages,
      async (packageName) => packageName === "moving-dep"
        ? {
          "1.0.0": {
            version: "1.0.0",
            unpublished: true
          }
        }
        : {
          "1.0.0": {
            version: "1.0.0",
            commonjs: {
              source: {
                name: "moving-parent",
                version: "1.0.0"
              },
              transformRevision: TRANSFORM_REVISION,
              buildKey: firstParent.buildKey
            }
          }
        }
    );
    const secondDependency = getPlan(secondPlans, "moving-dep");
    const secondParent = getPlan(secondPlans, "moving-parent");

    assert.equal(secondDependency.commonJsVersion, "1.0.1");
    assert.notEqual(secondParent.buildKey, firstParent.buildKey);
    assert.equal(secondParent.commonJsVersion, "1.0.1");
  });
});

test("rejects converted dependency cycles before allocating publishable releases", async () => {
  await withTemporaryDirectory("common-js-cycle-", async (directory) => {
    const nodeModulesPath = path.join(directory, "node_modules");
    const packageAPath = path.join(nodeModulesPath, "cycle-a", "package.json");
    const packageBPath = path.join(nodeModulesPath, "cycle-b", "package.json");

    await Promise.all([
      writeJson(packageAPath, {
        name: "cycle-a",
        version: "1.0.0",
        type: "module",
        license: "MIT",
        main: "./index.js",
        dependencies: {
          "cycle-b": "1.0.0"
        }
      }),
      writeJson(packageBPath, {
        name: "cycle-b",
        version: "1.0.0",
        type: "module",
        license: "MIT",
        main: "./index.js",
        dependencies: {
          "cycle-a": "1.0.0"
        }
      })
    ]);

    await assert.rejects(
      createConversionPlans(
        await readInstalledPackages([packageAPath, packageBPath]),
        async () => ({})
      ),
      /Circular converted package dependencies cannot be published safely/
    );
  });
});

test("tags releases by source identity when wrapper patches have moved ahead", async () => {
  await withTemporaryDirectory("common-js-publish-tag-", async (directory) => {
    const packageJsonPath = path.join(directory, "node_modules", "old-package", "package.json");

    await writeJson(packageJsonPath, {
      name: "old-package",
      version: "1.0.0",
      type: "module",
      license: "MIT",
      main: "./index.js"
    });

    const plans = await createConversionPlans(
      await readInstalledPackages([packageJsonPath]),
      async () => ({
        "1.0.0": {
          version: "1.0.0"
        },
        "1.0.1": {
          version: "1.0.1"
        }
      })
    );

    assert.equal(plans[0]?.commonJsVersion, "1.0.2");
    assert.equal(plans[0]?.publishTag, "commonjs");
  });
});

test("explicitly advances latest for a newer source even when its wrapper version is lower", async () => {
  await withTemporaryDirectory("common-js-latest-tag-", async (directory) => {
    const packageJsonPath = path.join(directory, "node_modules", "newer-source", "package.json");

    await writeJson(packageJsonPath, {
      name: "newer-source",
      version: "2.0.0",
      type: "module",
      license: "MIT",
      main: "./index.js"
    });

    const plans = await createConversionPlans(
      await readInstalledPackages([packageJsonPath]),
      async () => ({
        "9.0.0": {
          version: "9.0.0",
          commonjs: {
            source: {
              name: "newer-source",
              version: "1.0.0"
            },
            transformRevision: TRANSFORM_REVISION,
            buildKey: "older-source-build"
          }
        }
      })
    );

    assert.equal(plans[0]?.commonJsVersion, "2.0.0");
    assert.equal(plans[0]?.publishTag, "latest");
  });
});

test("does not treat an unpublished wrapper tombstone as a newer source release", async () => {
  await withTemporaryDirectory("common-js-tombstone-tag-", async (directory) => {
    const packageJsonPath = path.join(directory, "node_modules", "live-source", "package.json");

    await writeJson(packageJsonPath, {
      name: "live-source",
      version: "1.0.1",
      type: "module",
      license: "MIT",
      main: "./index.js"
    });

    const plans = await createConversionPlans(
      await readInstalledPackages([packageJsonPath]),
      async () => ({
        "1.0.2": {
          version: "1.0.2",
          unpublished: true
        }
      })
    );

    assert.equal(plans[0]?.commonJsVersion, "1.0.1");
    assert.equal(plans[0]?.publishTag, "latest");
  });
});

test("leaves declaration-only dependencies out of the conversion graph", async () => {
  await withTemporaryDirectory("common-js-types-only-dependency-", async (directory) => {
    const serializeErrorPackageJsonPath = path.join(
      directory,
      "node_modules",
      "serialize-error",
      "package.json"
    );
    const typeFestPackageJsonPath = path.join(
      directory,
      "node_modules",
      "type-fest",
      "package.json"
    );

    await Promise.all([
      writeJson(serializeErrorPackageJsonPath, {
        name: "serialize-error",
        version: "13.0.1",
        type: "module",
        license: "MIT",
        exports: {
          types: "./index.d.ts",
          default: "./index.js"
        },
        dependencies: {
          "type-fest": "^5.9.0"
        }
      }),
      writeJson(typeFestPackageJsonPath, {
        name: "type-fest",
        version: "5.9.0",
        type: "module",
        license: "MIT",
        exports: {
          ".": {
            types: "./index.d.ts"
          },
          "./globals": {
            types: "./source/globals/index.d.ts"
          }
        }
      })
    ]);

    const plans = await createConversionPlans(
      await readInstalledPackages([
        serializeErrorPackageJsonPath,
        typeFestPackageJsonPath
      ]),
      async () => ({})
    );

    assert.equal(plans.length, 1);
    const serializeErrorPlan = getPlan(plans, "serialize-error");
    assert.equal(serializeErrorPlan.convertedDependencies.size, 0);

    const convertedPackageJson = convertPackageJsonToCommonJs(
      serializeErrorPlan.installedPackage.packageJson,
      serializeErrorPlan.commonJsVersion,
      serializeErrorPlan.buildKey,
      getConvertedDependencies(serializeErrorPlan)
    );

    assert.equal(convertedPackageJson.dependencies?.["type-fest"], "^5.9.0");
  });
});

test("preserves exported subpaths and synthesizes require for import-only conditions", () => {
  const sourceExports = {
    ".": {
      types: "./dist/index.d.ts",
      import: {
        development: "./dist/development/index.js",
        default: "./dist/production/index.js"
      }
    },
    "./core": {
      types: "./dist/core.d.ts",
      development: "./dist/development/core.js",
      default: "./dist/production/core.js"
    },
    "./format-message/format-only": {
      types: "./dist/format-only.d.ts",
      import: "./dist/production/format-only.js"
    }
  } as PackageJson["exports"];
  const expectedExports = {
    ".": {
      types: "./dist/index.d.ts",
      require: {
        development: "./dist/development/index.js",
        default: "./dist/production/index.js"
      },
      import: {
        development: "./dist/development/index.js",
        default: "./dist/production/index.js"
      }
    },
    "./core": {
      types: "./dist/core.d.ts",
      development: "./dist/development/core.js",
      default: "./dist/production/core.js"
    },
    "./format-message/format-only": {
      types: "./dist/format-only.d.ts",
      require: "./dist/production/format-only.js",
      import: "./dist/production/format-only.js"
    }
  };

  assert.deepEqual(
    transformPackageExports(
      sourceExports,
      "use-intl",
      "@common.js/use-intl"
    ),
    expectedExports
  );
  assert.deepEqual(
    transformPackageExports(
      {
        import: "./dist/index.js",
        default: null
      },
      "use-intl",
      "@common.js/use-intl"
    ),
    {
      require: "./dist/index.js",
      import: "./dist/index.js",
      default: null
    }
  );
  const customConditionExports = transformPackageExports(
    {
      "react-server": "./dist/react-server.js",
      import: "./dist/index.js"
    },
    "use-intl",
    "@common.js/use-intl"
  ) as Record<string, unknown>;

  assert.deepEqual(Object.keys(customConditionExports), ["react-server", "require", "import"]);
  assert.deepEqual(customConditionExports, {
    "react-server": "./dist/react-server.js",
    require: "./dist/index.js",
    import: "./dist/index.js"
  });
  assert.deepEqual(
    transformPackageExports(
      {
        default: "./dist/fallback.js",
        import: "./dist/index.js"
      },
      "use-intl",
      "@common.js/use-intl"
    ),
    {
      require: "./dist/fallback.js",
      default: "./dist/fallback.js",
      import: "./dist/index.js"
    }
  );

  const sourcePackageJson = {
    name: "use-intl",
    version: "4.13.2",
    type: "module",
    license: "MIT",
    exports: sourceExports
  } as unknown as PackageJson;
  const packageWithRequire = {
    name: "use-intl",
    version: "4.13.2",
    type: "module",
    license: "MIT",
    exports: {
      ".": {
        import: "./dist/index.js",
        require: "./dist/index.cjs"
      }
    }
  } as unknown as PackageJson;

  assert.equal(isEsmOnly(sourcePackageJson), true);
  assert.equal(isEsmOnly(packageWithRequire), false);
  assert.equal(isEsmOnly({
    name: "types-only",
    version: "1.0.0",
    type: "module",
    exports: {
      ".": {
        types: "./index.d.ts"
      },
      "./globals": {
        "types@>=5": "./globals-modern.d.ts",
        types: "./globals.d.ts"
      }
    }
  } as PackageJson), false);
  assert.equal(isEsmOnly({
    name: "direct-types-only",
    version: "1.0.0",
    type: "module",
    exports: "./index.d.ts"
  } as PackageJson), false);
  assert.equal(isEsmOnly({
    name: "types-and-runtime",
    version: "1.0.0",
    type: "module",
    exports: {
      types: "./index.d.ts",
      import: "./index.js"
    }
  } as PackageJson), true);
  assert.equal(isEsmOnly({
    name: "blocked-require",
    version: "1.0.0",
    type: "module",
    exports: {
      import: "./index.js",
      require: null
    }
  } as PackageJson), true);
  assert.deepEqual(
    transformPackageExports(
      {
        import: "./index.js",
        require: null
      },
      "blocked-require",
      "@common.js/blocked-require"
    ),
    {
      require: "./index.js",
      import: "./index.js"
    }
  );
  assert.deepEqual(
    transformPackageExports(
      {
        require: null,
        default: "./index.js"
      },
      "blocked-require",
      "@common.js/blocked-require"
    ),
    {
      require: "./index.js",
      default: "./index.js"
    }
  );
  assert.deepEqual(
    transformPackageExports(
      {
        require: null,
        node: "./index.js"
      },
      "blocked-require",
      "@common.js/blocked-require"
    ),
    {
      node: "./index.js"
    }
  );
  assert.equal(isEsmOnly({
    name: "inactive-browser-require",
    version: "1.0.0",
    type: "module",
    exports: {
      browser: {
        require: "./browser.cjs",
        import: "./browser.js"
      },
      default: "./index.js"
    }
  } as PackageJson), true);

  const convertedPackageJson = convertPackageJsonToCommonJs(
    sourcePackageJson,
    "4.13.3",
    "exports-build",
    new Map()
  );

  assert.equal(convertedPackageJson.name, "@common.js/use-intl");
  assert.equal(convertedPackageJson.version, "4.13.3");
  assert.equal(convertedPackageJson.type, "commonjs");
  assert.equal(convertedPackageJson.main, "./dist/production/index.js");
  assert.equal(convertedPackageJson.types, "./dist/index.d.ts");
  assert.deepEqual(convertedPackageJson.exports, expectedExports);
  assert.deepEqual(convertedPackageJson.commonjs, {
    source: {
      name: "use-intl",
      version: "4.13.2"
    },
    transformRevision: TRANSFORM_REVISION,
    buildKey: "exports-build"
  });

  const customConditionPackage = convertPackageJsonToCommonJs(
    {
      name: "custom-condition-package",
      version: "1.0.0",
      type: "module",
      license: "MIT",
      exports: {
        "react-server": "./dist/react-server.js"
      }
    } as PackageJson,
    "1.0.0",
    "custom-condition-build",
    new Map()
  );

  assert.deepEqual(customConditionPackage.exports, {
    "react-server": "./dist/react-server.js"
  });
});

test("npm-alias layout supports direct require, require.resolve, and opaque createRequire aliases", async () => {
  await withTemporaryDirectory("common-js-alias-", async (directory) => {
    const nodeModulesPath = path.join(directory, "node_modules");
    const dependencyPath = path.join(nodeModulesPath, "dep");
    const importerPath = path.join(nodeModulesPath, "importer");
    const dependencyEntryPath = path.join(dependencyPath, "dist", "index.cjs");
    const dependencySubpathPath = path.join(dependencyPath, "dist", "feature.cjs");

    await Promise.all([
      writeJson(path.join(directory, "package.json"), {
        name: "fixture-consumer",
        private: true
      }),
      writeJson(path.join(dependencyPath, "package.json"), {
        name: "@common.js/dep",
        version: "2.0.0",
        type: "commonjs",
        exports: {
          ".": "./dist/index.cjs",
          "./feature": "./dist/feature.cjs"
        }
      }),
      writeText(dependencyEntryPath, "module.exports = {value: \"converted-root\"};\n"),
      writeText(dependencySubpathPath, "module.exports = {value: \"converted-feature\"};\n"),
      writeJson(path.join(importerPath, "package.json"), {
        name: "importer",
        version: "1.0.0",
        type: "commonjs",
        main: "./index.cjs",
        dependencies: {
          dep: "npm:@common.js/dep@2.0.0"
        }
      }),
      writeText(path.join(importerPath, "index.cjs"), [
        "const moduleApi = require(\"node:module\");",
        "const opaqueLoader = moduleApi.createRequire(__filename);",
        "module.exports = {",
        "  direct: require(\"dep\"),",
        "  directResolved: require.resolve(\"dep/feature\"),",
        "  opaque: opaqueLoader(\"dep\"),",
        "  opaqueResolved: opaqueLoader.resolve(\"dep/feature\")",
        "};",
        ""
      ].join("\n"))
    ]);

    type FixtureResult = {
      direct: { value: string };
      directResolved: string;
      opaque: { value: string };
      opaqueResolved: string;
    };

    const requireFromFixture = createRequire(path.join(directory, "package.json"));
    const result = requireFromFixture("importer") as FixtureResult;
    const resolvedDependencySubpath = await realpath(dependencySubpathPath);

    assert.deepEqual(result.direct, { value: "converted-root" });
    assert.deepEqual(result.opaque, { value: "converted-root" });
    assert.equal(result.directResolved, resolvedDependencySubpath);
    assert.equal(result.opaqueResolved, resolvedDependencySubpath);
  });
});

test("orders generated packages dependency-first and deduplicates identical releases", async () => {
  await withTemporaryDirectory("common-js-publish-order-", async (directory) => {
    const dependencyPackageJsonPath = path.join(directory, "dep", "package.json");
    const duplicateDependencyPackageJsonPath = path.join(directory, "dep-copy", "package.json");
    const parentPackageJsonPath = path.join(directory, "parent", "package.json");
    const metadata = (buildKey: string) => ({
      source: {
        name: buildKey,
        version: "1.0.0"
      },
      transformRevision: TRANSFORM_REVISION,
      buildKey
    });

    await Promise.all([
      writeJson(dependencyPackageJsonPath, {
        name: "@common.js/dep",
        version: "2.0.0",
        commonjs: metadata("dep-build")
      }),
      writeJson(duplicateDependencyPackageJsonPath, {
        name: "@common.js/dep",
        version: "2.0.0",
        commonjs: metadata("dep-build")
      }),
      writeJson(parentPackageJsonPath, {
        name: "@common.js/parent",
        version: "1.0.0",
        dependencies: {
          dep: "npm:@common.js/dep@2.0.0"
        },
        commonjs: metadata("parent-build")
      })
    ]);

    const orderedPackages = await orderPackagesForPublishing([
      parentPackageJsonPath,
      duplicateDependencyPackageJsonPath,
      dependencyPackageJsonPath
    ]);

    assert.deepEqual(
      orderedPackages.map(({ key }) => key),
      ["@common.js/dep@2.0.0", "@common.js/parent@1.0.0"]
    );
  });
});

test("accepts only an existing package with the same generated build", async () => {
  await withTemporaryDirectory("common-js-publish-collision-", async (directory) => {
    await writeJson(path.join(directory, "package.json"), {
      name: "@common.js/collision-fixture",
      version: "1.0.0",
      commonjs: {
        source: {
          name: "collision-fixture",
          version: "1.0.0"
        },
        transformRevision: TRANSFORM_REVISION,
        buildKey: "expected-build"
      }
    });

    const publishError = new Error("Cannot publish over existing version.");
    const getRunner = (
      publishedVersion: string | undefined,
      publishedBuildKey?: string
    ) => {
      const commands: string[] = [];
      const runCommand = async (command: string) => {
        commands.push(command);

        if (command.includes("npm publish")) {
          throw publishError;
        }

        return {
          stdout: publishedVersion === undefined
            ? ""
            : JSON.stringify({
              version: publishedVersion,
              commonjs: publishedBuildKey === undefined
                ? undefined
                : { buildKey: publishedBuildKey }
            }),
          stderr: ""
        };
      };

      return { commands, runCommand };
    };
    for (const publishedBuildKey of ["different-build", undefined]) {
      const mismatch = getRunner("1.0.0", publishedBuildKey);

      await assert.rejects(
        publishPackage(directory, { runCommand: mismatch.runCommand }),
        /already published with different generated contents/
      );
    }

    for (const missing of [getRunner(undefined), getRunner("2.0.0", "expected-build")]) {
      await assert.rejects(
        publishPackage(directory, { runCommand: missing.runCommand }),
        (error) => error === publishError
      );
    }

    const lookupFailureCommands: string[] = [];

    await assert.rejects(
      publishPackage(directory, {
        runCommand: async (command) => {
          lookupFailureCommands.push(command);
          throw command.includes("npm publish") ? publishError : new Error("Registry unavailable");
        }
      }),
      (error) => error === publishError
    );
    assert.equal(lookupFailureCommands.length, 2);

    const matching = getRunner("1.0.0", "expected-build");

    await publishPackage(directory, {
      tag: "commonjs",
      runCommand: matching.runCommand,
      dryRun: false
    });
    assert.match(matching.commands[0] ?? "", /--tag "commonjs"/);
    assert.match(
      matching.commands[1] ?? "",
      /npm view .* --json/
    );
    assert.match(matching.commands[2] ?? "", /npm dist-tag add .* "commonjs"/);
    assert.equal(matching.commands.length, 3);

    const cachedCommands: string[] = [];

    await publishPackage(directory, {
      tag: "latest",
      dryRun: false,
      runCommand: async (command) => {
        cachedCommands.push(command);
        return { stdout: "", stderr: "" };
      }
    });
    assert.equal(cachedCommands.length, 1);
    assert.match(cachedCommands[0] ?? "", /npm dist-tag add .* "latest"/);
  });
});

test("does not let a dry-run completion suppress a later real publish", async () => {
  await withTemporaryDirectory("common-js-dry-real-", async (directory) => {
    await writeJson(path.join(directory, "package.json"), {
      name: "@common.js/dry-real-fixture",
      version: "1.0.0",
      commonjs: {
        source: {
          name: "dry-real-fixture",
          version: "1.0.0"
        },
        transformRevision: TRANSFORM_REVISION,
        buildKey: "dry-real-build"
      }
    });

    const commands: string[] = [];
    const runCommand = async (command: string) => {
      commands.push(command);
      return { stdout: "", stderr: "" };
    };

    await publishPackage(directory, {
      tag: "latest",
      dryRun: true,
      runCommand
    });
    await publishPackage(directory, {
      tag: "latest",
      dryRun: false,
      runCommand
    });

    assert.equal(commands.filter((command) => command.includes("npm publish")).length, 2);
    assert.match(commands[0] ?? "", /--dry-run/);
    assert.doesNotMatch(commands[1] ?? "", /--dry-run/);
  });
});

test("reloads a manifest when a temporary package path is reused", async () => {
  await withTemporaryDirectory("common-js-manifest-reload-", async (directory) => {
    const writeManifest = (version: string, buildKey: string) => writeJson(
      path.join(directory, "package.json"),
      {
        name: "@common.js/manifest-reload-fixture",
        version,
        commonjs: {
          source: {
            name: "manifest-reload-fixture",
            version
          },
          transformRevision: TRANSFORM_REVISION,
          buildKey
        }
      }
    );
    const commands: string[] = [];
    const runCommand = async (command: string) => {
      commands.push(command);

      if (command.includes("npm publish")) {
        throw new Error("Cannot publish over existing version.");
      }

      return {
        stdout: JSON.stringify({
          version: command.includes("@2.0.0") ? "2.0.0" : "1.0.0",
          commonjs: {
            buildKey: command.includes("@2.0.0") ? "build-two" : "build-one"
          }
        }),
        stderr: ""
      };
    };

    await writeManifest("1.0.0", "build-one");
    await publishPackage(directory, { runCommand, dryRun: true });
    await writeManifest("2.0.0", "build-two");
    await publishPackage(directory, { runCommand, dryRun: true });

    const viewCommands = commands.filter((command) => command.startsWith("npm view"));
    assert.equal(viewCommands.length, 2);
    assert.match(viewCommands[0] ?? "", /@1\.0\.0/);
    assert.match(viewCommands[1] ?? "", /@2\.0\.0/);
  });
});

test("rewrites every package self-reference string, including resolver and opaque aliases", async () => {
  assert.equal(
    rewritePackageSelfReference(
      "self-package/feature",
      "self-package",
      "@common.js/self-package"
    ),
    "@common.js/self-package/feature"
  );
  assert.equal(
    rewritePackageSelfReference(
      "self-package-extra",
      "self-package",
      "@common.js/self-package"
    ),
    "self-package-extra"
  );

  await withTemporaryDirectory("common-js-self-reference-", async (directory) => {
    const sourcePath = path.join(directory, "index.js");
    const source = [
      "const moduleApi = require(\"node:module\");",
      "const opaqueLoader = moduleApi.createRequire(__filename);",
      "module.exports = {",
      "  direct: require(\"self-package\"),",
      "  directResolved: require.resolve(\"self-package/feature\"),",
      "  opaque: opaqueLoader(\"self-package\"),",
      "  opaqueResolved: opaqueLoader.resolve(`self-package/feature`),",
      "  tagged: opaqueLoader`self-package/feature`,",
      "  stringValue: \"self-package/internal\",",
      "  lookalike: \"self-package-extra\",",
      "  relative: \"./self-package\"",
      "};",
      ""
    ].join("\n");
    const expected = [
      "const moduleApi = require(\"node:module\");",
      "const opaqueLoader = moduleApi.createRequire(__filename);",
      "module.exports = {",
      "  direct: require(\"@common.js/self-package\"),",
      "  directResolved: require.resolve(\"@common.js/self-package/feature\"),",
      "  opaque: opaqueLoader(\"@common.js/self-package\"),",
      "  opaqueResolved: opaqueLoader.resolve(`@common.js/self-package/feature`),",
      "  tagged: opaqueLoader`@common.js/self-package/feature`,",
      "  stringValue: \"@common.js/self-package/internal\",",
      "  lookalike: \"self-package-extra\",",
      "  relative: \"./self-package\"",
      "};",
      ""
    ].join("\n");

    await writeText(sourcePath, source);
    await rewritePackageSelfReferences(
      directory,
      "self-package",
      "@common.js/self-package"
    );

    assert.equal(await readFile(sourcePath, "utf8"), expected);
  });
});

const main = async () => {
  for (const currentTest of tests) {
    try {
      await currentTest.run();
      console.log(`ok - ${currentTest.name}`);
    } catch (error) {
      console.error(`not ok - ${currentTest.name}`);
      throw error;
    }
  }

  console.log(`${tests.length} tests passed`);
};

void main();
