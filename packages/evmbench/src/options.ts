import path from "node:path";

export function invocationCwd(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return path.resolve(env.INIT_CWD ?? cwd);
}

export function resolveCliPath(value: string | undefined, base = invocationCwd()): string | undefined {
  return value === undefined ? undefined : path.resolve(base, value);
}

export function requireCliPath(value: string | undefined, name: string, base = invocationCwd()): string {
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return path.resolve(base, value);
}
