export function passwordFromEnvironment(
  name: string | undefined,
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (name === undefined) return undefined;
  const password = environment[name];
  if (password === undefined) {
    throw new Error(`environment variable "${name}" named by --password-env is not set`);
  }
  if (password.length === 0) {
    throw new Error(`environment variable "${name}" named by --password-env is empty`);
  }
  return password;
}
