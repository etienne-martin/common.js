import { promisify } from "node:util";
import _glob from "glob";

export const glob = promisify(_glob);