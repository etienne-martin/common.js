import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { exec } from "./utils/exec";
import { glob } from "./utils/glob";

type Replacement = {
  start: number;
  end: number;
  text: string;
};

const REWRITABLE_EXTENSIONS = ["js", "cjs", "mjs", "jsx", "ts", "cts", "mts", "tsx"];

export const rewritePackageSelfReference = (
  value: string,
  sourcePackageName: string,
  commonJsPackageName: string
) => {
  if (value !== sourcePackageName && !value.startsWith(`${sourcePackageName}/`)) {
    return value;
  }

  return `${commonJsPackageName}${value.slice(sourcePackageName.length)}`;
};

const isStringLiteralLike = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => (
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
);

const quoteRewrittenString = (
  node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral,
  value: string
) => {
  if (!ts.isNoSubstitutionTemplateLiteral(node)) {
    return JSON.stringify(value);
  }

  const escapedValue = value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");

  return `\`${escapedValue}\``;
};

const getScriptKind = (filePath: string) => {
  if (filePath.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }

  if (filePath.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }

  if (filePath.endsWith(".ts") || filePath.endsWith(".cts") || filePath.endsWith(".mts")) {
    return ts.ScriptKind.TS;
  }

  return ts.ScriptKind.JS;
};

const rewriteSelfReferencesInFile = async (
  filePath: string,
  sourcePackageName: string,
  commonJsPackageName: string
) => {
  const source = await readFile(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath)
  );
  const replacements: Replacement[] = [];

  const visit = (node: ts.Node): void => {
    if (isStringLiteralLike(node)) {
      const rewrittenValue = rewritePackageSelfReference(
        node.text,
        sourcePackageName,
        commonJsPackageName
      );

      if (rewrittenValue !== node.text) {
        replacements.push({
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          text: quoteRewrittenString(node, rewrittenValue)
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!replacements.length) {
    return;
  }

  const rewrittenSource = replacements
    .sort((a, b) => b.start - a.start)
    .reduce(
      (updatedSource, replacement) => (
        updatedSource.slice(0, replacement.start) + replacement.text + updatedSource.slice(replacement.end)
      ),
      source
    );

  await writeFile(filePath, rewrittenSource);
};

export const rewritePackageSelfReferences = async (
  packagePath: string,
  sourcePackageName: string,
  commonJsPackageName: string
) => {
  const files = (await Promise.all(
    REWRITABLE_EXTENSIONS.map((extension) => glob(
      path.resolve(packagePath, `**/*.${extension}`),
      { nodir: true }
    ))
  )).flat().filter((filePath) => (
    !path.relative(packagePath, filePath).split(path.sep).includes("node_modules")
  ));

  await Promise.all(
    files.map((filePath) => rewriteSelfReferencesInFile(
      filePath,
      sourcePackageName,
      commonJsPackageName
    ))
  );
};

export const transpilePackage = async (packagePath: string, destination: string) => exec(
  `yarn swc "${packagePath}" --out-dir "${destination}"`
);
