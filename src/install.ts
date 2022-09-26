import path from "node:path";
import { exec } from "./utils/exec";

export const installDeps = async (packageDir: string) => {
  console.time(`Installed ${path.basename(packageDir)}`);

  await exec(
    `cd "${packageDir}" && npm install --no-package-lock`
  );

  console.timeEnd(`Installed ${path.basename(packageDir)}`);
};
