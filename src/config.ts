import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const OP_TOKEN_REFERENCE =
  /^op:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const FactoryConfigSchema = Type.Object(
  {
    version: Type.Literal(1),
    linear: Type.Optional(
      Type.Object(
        {
          tokenReference: Type.String({ pattern: OP_TOKEN_REFERENCE.source }),
        },
        { additionalProperties: false },
      ),
    ),
    openrouter: Type.Optional(
      Type.Object(
        {
          tokenReference: Type.String({ pattern: OP_TOKEN_REFERENCE.source }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type FactoryConfig = Static<typeof FactoryConfigSchema>;

export function factoryConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  homedir = defaultHomedir,
): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const root = xdg && !xdg.includes("\0") && isAbsolute(xdg) ? xdg : resolve(homedir(), ".config");
  return resolve(root, "factory", "config.json");
}

export function parseTokenReference(value: string, label = "Linear"): string {
  const trimmed = value.trim();
  if (!OP_TOKEN_REFERENCE.test(trimmed)) throw new Error(`invalid ${label} token reference`);
  return trimmed;
}

export function parseFactoryConfig(text: string): FactoryConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("invalid factory config");
  }
  if (!Value.Check(FactoryConfigSchema, value)) throw new Error("invalid factory config");
  if (value.linear) parseTokenReference(value.linear.tokenReference);
  if (value.openrouter) parseTokenReference(value.openrouter.tokenReference, "OpenRouter");
  return value;
}

export interface LoadFactoryConfigOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: typeof defaultHomedir;
  readFile?: (path: string) => string;
}

export function loadFactoryConfig(options: LoadFactoryConfigOptions = {}): FactoryConfig {
  const path = factoryConfigPath(options.env, options.homedir);
  try {
    const text = (options.readFile ?? ((file) => readFileSync(file, "utf8")))(path);
    return parseFactoryConfig(text);
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return { version: 1 };
    if (
      error instanceof Error &&
      (error.message === "invalid factory config" ||
        error.message === "invalid Linear token reference" ||
        error.message === "invalid OpenRouter token reference")
    )
      throw error;
    throw new Error("invalid factory config", { cause: error });
  }
}

export function writeFactoryConfig(
  config: FactoryConfig,
  options: { env?: NodeJS.ProcessEnv; homedir?: typeof defaultHomedir } = {},
): string {
  if (!Value.Check(FactoryConfigSchema, config)) throw new Error("invalid factory config");
  const path = factoryConfigPath(options.env, options.homedir);
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  chmodSync(resolve(path, ".."), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return path;
}

function record(value: unknown): value is { code?: unknown } {
  return value !== null && typeof value === "object";
}
