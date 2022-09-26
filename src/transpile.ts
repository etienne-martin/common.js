import { exec } from "./utils/exec";

export const transpilePackage = async (packagePath: string, destination: string) => exec(
  `yarn swc "${packagePath}" --out-dir "${destination}"`
);