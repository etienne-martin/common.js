export const escapePackageName = (packageName: string) => {
  // Same as Definitely Typed: https://github.com/microsoft/TypeScript/issues/14819
  return `test__${packageName.replace(/^@/, "").replace("/", "__")}`;
};