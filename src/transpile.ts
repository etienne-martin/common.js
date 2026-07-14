import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { escapePackageName } from "./package-name";
import { exec } from "./utils/exec";
import { glob } from "./utils/glob";

type Replacement = {
  start: number;
  end: number;
  text: string;
};

const REWRITABLE_EXTENSIONS = ["js", "cjs", "mjs", "jsx", "ts", "cts", "mts", "tsx"];

const getPackageName = (moduleSpecifier: string) => {
  if (
    !moduleSpecifier ||
    moduleSpecifier.startsWith(".") ||
    moduleSpecifier.startsWith("#") ||
    path.isAbsolute(moduleSpecifier)
  ) {
    return;
  }

  if (moduleSpecifier.startsWith("@")) {
    const [scope, name] = moduleSpecifier.split("/");

    if (!scope || !name) {
      return;
    }

    return `${scope}/${name}`;
  }

  return moduleSpecifier.split("/")[0];
};

export const rewriteCommonJsImport = (
  moduleSpecifier: string,
  esmPackageNames: ReadonlySet<string>
) => {
  const packageName = getPackageName(moduleSpecifier);

  if (!packageName || !esmPackageNames.has(packageName)) {
    return moduleSpecifier;
  }

  return `@common.js/${escapePackageName(packageName)}${moduleSpecifier.slice(packageName.length)}`;
};

const isStringLiteralLike = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => (
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
);

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

const rewriteImportSpecifiersInFile = async (
  filePath: string,
  esmPackageNames: ReadonlySet<string>
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

  const addReplacement = (literal: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral) => {
    const rewrittenModuleSpecifier = rewriteCommonJsImport(literal.text, esmPackageNames);

    if (rewrittenModuleSpecifier === literal.text) {
      return;
    }

    replacements.push({
      start: literal.getStart(sourceFile),
      end: literal.getEnd(),
      text: JSON.stringify(rewrittenModuleSpecifier)
    });
  };

  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (isStringLiteralLike(node.moduleSpecifier)) {
        addReplacement(node.moduleSpecifier);
      }
    } else if (ts.isExternalModuleReference(node)) {
      if (isStringLiteralLike(node.expression)) {
        addReplacement(node.expression);
      }
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument) && isStringLiteralLike(node.argument.literal)) {
        addReplacement(node.argument.literal);
      }
    } else if (ts.isCallExpression(node)) {
      const [moduleSpecifier] = node.arguments;
      const isRequireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;

      if ((isRequireCall || isDynamicImport) && moduleSpecifier && isStringLiteralLike(moduleSpecifier)) {
        addReplacement(moduleSpecifier);
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

export const rewriteCommonJsImports = async (
  packagePath: string,
  esmModules: Record<string, string[]>
) => {
  const esmPackageNames = new Set(Object.keys(esmModules));

  if (!esmPackageNames.size) {
    return;
  }

  const files = (await Promise.all(
    REWRITABLE_EXTENSIONS.map((extension) => glob(path.resolve(packagePath, `**/*.${extension}`), { nodir: true }))
  )).flat();

  await Promise.all(
    files.map((filePath) => rewriteImportSpecifiersInFile(filePath, esmPackageNames))
  );
};

export const transpilePackage = async (
  packagePath: string,
  destination: string,
  esmModules: Record<string, string[]>
) => {
  await exec(
    `yarn swc "${packagePath}" --out-dir "${destination}"`
  );

  await rewriteCommonJsImports(destination, esmModules);
};
