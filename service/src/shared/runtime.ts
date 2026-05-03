export function isDirectRun(metaUrl: string, argv: readonly string[] = process.argv): boolean {
  const entrypoint = argv[1];
  return typeof entrypoint === "string" && metaUrl.endsWith(entrypoint);
}
