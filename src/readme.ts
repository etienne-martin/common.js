import path from "node:path";
import { rm, writeFile } from "node:fs/promises";

type SourcePackage = {
  name: string;
  version: string;
};

const readmeTemplate = (sourcePackage: SourcePackage, commonJsPackageName: string) => `
# ${commonJsPackageName}

The [${sourcePackage.name}](https://www.npmjs.com/package/${sourcePackage.name}) package exported as CommonJS modules.

Exported from [${sourcePackage.name}@${sourcePackage.version}](https://www.npmjs.com/package/${sourcePackage.name}/v/${sourcePackage.version}) using https://github.com/etienne-martin/common.js.

`.trim();

export const replaceReadme = async (
  packagePath: string,
  sourcePackage: SourcePackage,
  commonJsPackageName: string
) => {
  const readmePath = path.resolve(packagePath, "README.md");
  const newReadmeContent = readmeTemplate(sourcePackage, commonJsPackageName);

  await rm(path.resolve(packagePath, "README.md"), { force: true });
  await rm(path.resolve(packagePath, "readme.md"), { force: true });

  await writeFile(readmePath, newReadmeContent);
};
