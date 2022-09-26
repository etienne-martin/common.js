import { PackageJson } from "type-fest";
import path from "node:path";
import { exec } from "./utils/exec";

const DRY_RUN = process.env.DISABLE_DRY_RUN !== "true";

export const publishPackage = async (packagePath: string) => {
  const packageJson: PackageJson = require(path.resolve(packagePath, "package.json"));

  try {
    console.time(`${packageJson.name}@${packageJson.version} has been published`);
    await exec(`cd "${packagePath}" && npm publish --access public ${DRY_RUN ? "--dry-run" : ""}`);
    console.timeEnd(`${packageJson.name}@${packageJson.version} has been published`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("You cannot publish over the previously published versions")) {
      console.log(`${packageJson.name}@${packageJson.version} is already published`);
      return;
    }
    throw error;
  }
};