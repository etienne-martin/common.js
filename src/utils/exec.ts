import { promisify } from "node:util";
import { exec as _exec } from "node:child_process";

export const exec = promisify(_exec);