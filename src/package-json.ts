import is, { assert } from "@sindresorhus/is";
import { PackageJson } from "type-fest";
import { rewritePackageSelfReference } from "./transpile";
import { CommonJsMetadata, TRANSFORM_REVISION, getCommonJsPackageName } from "./version";

export type ConvertedDependency = {
  packageName: string;
  version: string;
};

type PackageEntrypoints = Pick<PackageJson, "browser" | "main" | "types">;

type CommonJsPackageJson = PackageJson & {
  commonjs: CommonJsMetadata;
  imports?: unknown;
};

const SUPPORTED_LICENSES = ["BSD-3-CLAUSE", "MIT"];

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const isSupportedLicense = (license: string | undefined) => (
  !!license && SUPPORTED_LICENSES.some((supportedLicense) => license.includes(supportedLicense))
);

const hasRootExport = (exports: PackageJson["exports"]) => {
  if (!isRecord(exports)) {
    return true;
  }

  const exportKeys = Object.keys(exports);
  return exportKeys.includes(".") || exportKeys.every((key) => !key.startsWith("."));
};

const getRootExport = (exports: PackageJson["exports"]): unknown => {
  if (!isRecord(exports)) {
    return exports;
  }

  const exportMap = exports as Record<string, unknown>;

  if ("." in exportMap) {
    return exportMap["."];
  }

  return hasRootExport(exports) ? exports : undefined;
};

const findExportTarget = (exportValue: unknown, conditions: readonly string[]): string | undefined => {
  if (typeof exportValue === "string") {
    return exportValue;
  }

  if (Array.isArray(exportValue)) {
    for (const fallback of exportValue) {
      const target = findExportTarget(fallback, conditions);

      if (target) {
        return target;
      }
    }

    return;
  }

  if (!isRecord(exportValue)) {
    return;
  }

  for (const condition of conditions) {
    if (condition in exportValue) {
      const target = findExportTarget(exportValue[condition], conditions);

      if (target) {
        return target;
      }
    }
  }
};

const findFirstStringTarget = (exportValue: unknown): string | undefined => {
  if (typeof exportValue === "string") {
    return exportValue;
  }

  if (Array.isArray(exportValue)) {
    for (const fallback of exportValue) {
      const target = findFirstStringTarget(fallback);

      if (target) {
        return target;
      }
    }

    return;
  }

  if (!isRecord(exportValue)) {
    return;
  }

  for (const targetValue of Object.values(exportValue)) {
    const target = findFirstStringTarget(targetValue);

    if (target) {
      return target;
    }
  }
};

const findConditionTarget = (exportValue: unknown, condition: string): string | undefined => {
  if (Array.isArray(exportValue)) {
    for (const fallback of exportValue) {
      const target = findConditionTarget(fallback, condition);

      if (target) {
        return target;
      }
    }

    return;
  }

  if (!isRecord(exportValue)) {
    return;
  }

  if (condition in exportValue) {
    return findFirstStringTarget(exportValue[condition]);
  }

  for (const nestedValue of Object.values(exportValue)) {
    const target = findConditionTarget(nestedValue, condition);

    if (target) {
      return target;
    }
  }
};

const getEntrypointsFromExport = (exportValue: unknown): PackageEntrypoints => {
  const main = findExportTarget(
    exportValue,
    ["require", "node", "default", "import", "browser", "development", "production"]
  );
  const browser = findExportTarget(exportValue, ["browser", "default", "import"]);
  const types = findConditionTarget(exportValue, "types");

  return {
    ...(main ? { main } : {}),
    ...(browser && browser !== main ? { browser } : {}),
    ...(types ? { types } : {})
  };
};

const transformConditionalValue = (
  value: unknown,
  sourcePackageName: string,
  commonJsPackageName: string
): unknown => {
  if (typeof value === "string") {
    return rewritePackageSelfReference(value, sourcePackageName, commonJsPackageName);
  }

  if (Array.isArray(value)) {
    return value.map((fallback) => transformConditionalValue(
      fallback,
      sourcePackageName,
      commonJsPackageName
    ));
  }

  if (!isRecord(value)) {
    return value;
  }

  const hasImportCondition = "import" in value;
  const hasDefaultCondition = "default" in value;
  const hasBlockedRequireCondition = value.require === null;
  const shouldAddRequireCondition = (
    (!("require" in value) && hasImportCondition) ||
    (hasBlockedRequireCondition && (hasImportCondition || hasDefaultCondition))
  );
  const transformedValue: Record<string, unknown> = {};
  let hasAddedRequireCondition = false;
  const conditions = Object.keys(value);
  const importIndex = conditions.indexOf("import");
  const defaultIndex = conditions.indexOf("default");
  const requireTarget = defaultIndex >= 0 && (importIndex < 0 || defaultIndex < importIndex)
    ? value.default
    : value.import;

  for (const [condition, target] of Object.entries(value)) {
    if (
      shouldAddRequireCondition &&
      !hasAddedRequireCondition &&
      (condition === "import" || condition === "default")
    ) {
      transformedValue.require = transformConditionalValue(
        requireTarget,
        sourcePackageName,
        commonJsPackageName
      );
      hasAddedRequireCondition = true;
    }

    if (condition === "require" && hasBlockedRequireCondition) {
      continue;
    }

    transformedValue[condition] = transformConditionalValue(
      target,
      sourcePackageName,
      commonJsPackageName
    );
  }

  return transformedValue;
};

export const transformPackageExports = (
  exports: PackageJson["exports"],
  sourcePackageName: string,
  commonJsPackageName: string
): PackageJson["exports"] => {
  if (!isRecord(exports)) {
    return transformConditionalValue(
      exports,
      sourcePackageName,
      commonJsPackageName
    ) as PackageJson["exports"];
  }

  const isSubpathMap = Object.keys(exports).some((key) => key.startsWith("."));

  if (!isSubpathMap) {
    return transformConditionalValue(
      exports,
      sourcePackageName,
      commonJsPackageName
    ) as PackageJson["exports"];
  }

  return Object.fromEntries(Object.entries(exports).map(([subpath, target]) => [
    subpath,
    transformConditionalValue(target, sourcePackageName, commonJsPackageName)
  ])) as PackageJson["exports"];
};

const transformPackageImports = (
  imports: unknown,
  sourcePackageName: string,
  commonJsPackageName: string
) => {
  if (!isRecord(imports)) {
    return imports;
  }

  return Object.fromEntries(Object.entries(imports).map(([specifier, target]) => [
    specifier,
    transformConditionalValue(target, sourcePackageName, commonJsPackageName)
  ]));
};

const transformDependencies = (
  dependencies: PackageJson["dependencies"],
  convertedDependencies: ReadonlyMap<string, ConvertedDependency>
) => {
  if (!dependencies) {
    return dependencies;
  }

  return Object.fromEntries(Object.entries(dependencies).map(([dependencyName, range]) => {
    const convertedDependency = convertedDependencies.get(dependencyName);

    if (!convertedDependency) {
      return [dependencyName, range];
    }

    return [
      dependencyName,
      `npm:${convertedDependency.packageName}@${convertedDependency.version}`
    ];
  }));
};

const resolveStandardRequireTarget = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    for (const fallback of value) {
      const target = resolveStandardRequireTarget(fallback);

      if (target !== undefined) {
        return target;
      }
    }

    return;
  }

  if (!isRecord(value)) {
    return value;
  }

  const standardRequireConditions = new Set(["node-addons", "node", "require", "default"]);

  for (const [condition, targetValue] of Object.entries(value)) {
    if (!standardRequireConditions.has(condition)) {
      continue;
    }

    const target = resolveStandardRequireTarget(targetValue);

    if (target !== undefined) {
      return target;
    }
  }
};

const isCommonJsTarget = (value: unknown) => (
  typeof value === "string" && /\.(?:cjs|json|node)$/.test(value)
);

export const isEsmOnly = (packageJson: PackageJson) => {
  if (packageJson.type !== "module") {
    return false;
  }

  const hasCommonJsMain = is.string(packageJson.main) && packageJson.main.endsWith(".cjs");
  const rootExport = getRootExport(packageJson.exports);

  return !hasCommonJsMain && !isCommonJsTarget(resolveStandardRequireTarget(rootExport));
};

export const convertPackageJsonToCommonJs = (
  packageJson: PackageJson,
  commonJsVersion: string,
  buildKey: string,
  convertedDependencies: ReadonlyMap<string, ConvertedDependency>
) => {
  assert.string(packageJson.name);
  assert.string(packageJson.version);

  const sourcePackageName = packageJson.name;
  const sourcePackageVersion = packageJson.version;
  const commonJsPackageName = getCommonJsPackageName(sourcePackageName);
  const packageJsonWithImports = packageJson as PackageJson & { imports?: unknown };
  const license = packageJson.license?.toUpperCase();

  if (!isSupportedLicense(license)) {
    throw new Error(`Unsupported license: ${packageJson.license}`);
  }

  const newPackageJson = {
    ...packageJson,
    name: commonJsPackageName,
    version: commonJsVersion,
    repository: "etienne-martin/common.js",
    homepage: "https://github.com/etienne-martin/common.js#readme",
    type: "commonjs",
    description: `${sourcePackageName} package exported as CommonJS modules`,
    exports: transformPackageExports(
      packageJson.exports,
      sourcePackageName,
      commonJsPackageName
    ),
    imports: transformPackageImports(
      packageJsonWithImports.imports,
      sourcePackageName,
      commonJsPackageName
    ) as PackageJson["imports"],
    module: undefined,
    keywords: undefined,
    author: undefined,
    dependencies: transformDependencies(packageJson.dependencies ?? {}, convertedDependencies) ?? {},
    optionalDependencies: transformDependencies(packageJson.optionalDependencies, convertedDependencies),
    peerDependencies: transformDependencies(packageJson.peerDependencies, convertedDependencies),
    scripts: {
      ...packageJson.scripts,
      postpack: undefined,
      postpublish: undefined,
      prepare: undefined,
      prepublish: undefined,
      prepack: undefined,
      prepublishOnly: undefined,
      publish: undefined
    },
    commonjs: {
      source: {
        name: sourcePackageName,
        version: sourcePackageVersion
      },
      transformRevision: TRANSFORM_REVISION,
      buildKey
    }
  } as unknown as CommonJsPackageJson;

  if (packageJson.exports) {
    const entrypoints = getEntrypointsFromExport(getRootExport(packageJson.exports));

    newPackageJson.browser = entrypoints.browser ?? newPackageJson.browser;
    newPackageJson.main = entrypoints.main ?? newPackageJson.main;
    newPackageJson.types = entrypoints.types ?? newPackageJson.types;
  }

  return newPackageJson;
};
