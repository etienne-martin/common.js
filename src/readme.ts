import { PackageJson } from "type-fest";
import { assert } from "@sindresorhus/is";
import path from "node:path";
import {rm, writeFile} from "node:fs/promises";
import { escapePackageName } from "./package-name";

const readmeTemplate = (packageJson: Required<Pick<PackageJson, "name" | "version">>) => `
# @common.js/${escapePackageName(packageJson.name)}

The [${packageJson.name}](https://www.npmjs.com/package/${packageJson.name}) package exported as CommonJS modules.

Exported from [${packageJson.name}@${packageJson.version}](https://www.npmjs.com/package/${packageJson.name}/v/${packageJson.version}) using https://github.com/etienne-martin/common.js.

`.trim();

export const replaceReadme = async (packagePath: string) => {
  const readmePath = path.resolve(packagePath, "README.md");
  const packageJsonPath = path.resolve(packagePath, "package.json");
  const packageJson: PackageJson = require(packageJsonPath);

  assert.string(packageJson.name);
  assert.string(packageJson.version);

  const newReadmeContent = readmeTemplate({
    name: packageJson.name,
    version: packageJson.version
  });

  await rm(path.resolve(packagePath, "README.md"), { force: true });
  await rm(path.resolve(packagePath, "readme.md"), { force: true });

  await writeFile(readmePath, newReadmeContent);
};