import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const OP_TOKEN_REFERENCE =
  /^op:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const CredentialSchema = Type.Union([
  Type.Object(
    { token: Type.String({ minLength: 1, maxLength: 4096, pattern: "^[\\x21-\\x7e]+$" }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { tokenReference: Type.String({ pattern: OP_TOKEN_REFERENCE.source }) },
    { additionalProperties: false },
  ),
]);
export type SavedCredential = Static<typeof CredentialSchema>;

export function parseApiToken(value: string): string {
  const token = value.trim();
  if (!Value.Check(CredentialSchema, { token })) throw new Error("invalid API key");
  return token;
}

const MaquilaConfigSchema = Type.Object(
  {
    version: Type.Literal(1),
    linear: Type.Optional(CredentialSchema),
    openrouter: Type.Optional(CredentialSchema),
  },
  { additionalProperties: false },
);

export type MaquilaConfig = Static<typeof MaquilaConfigSchema>;

export function maquilaConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  homedir = defaultHomedir,
): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const root = xdg && !xdg.includes("\0") && isAbsolute(xdg) ? xdg : resolve(homedir(), ".config");
  return resolve(root, "maquila", "config.json");
}

function realpathExisting(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    const parent = resolve(resolved, "..");
    if (parent === resolved) return resolved;
    return resolve(realpathExisting(parent), resolved.slice(parent.length + 1));
  }
}

export function assertConfigOutsideTarget(configPath: string, target = process.cwd()): void {
  const rel = relative(realpathExisting(target), realpathExisting(configPath));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)))
    throw new Error("maquila config must not be stored in the target repository");
}

export function parseTokenReference(value: string, label = "Linear"): string {
  const trimmed = value.trim();
  if (!OP_TOKEN_REFERENCE.test(trimmed)) throw new Error(`invalid ${label} token reference`);
  return trimmed;
}

export function parseMaquilaConfig(text: string): MaquilaConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("invalid maquila config");
  }
  if (!Value.Check(MaquilaConfigSchema, value)) throw new Error("invalid maquila config");
  if (value.linear && "tokenReference" in value.linear)
    parseTokenReference(value.linear.tokenReference);
  if (value.openrouter && "tokenReference" in value.openrouter)
    parseTokenReference(value.openrouter.tokenReference, "OpenRouter");
  return value;
}

export interface LoadMaquilaConfigOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: typeof defaultHomedir;
  readFile?: (path: string) => string;
}

function readPrivateConfig(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 32_768 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("invalid maquila config");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function loadMaquilaConfig(options: LoadMaquilaConfigOptions = {}): MaquilaConfig {
  const path = maquilaConfigPath(options.env, options.homedir);
  try {
    const text = (options.readFile ?? readPrivateConfig)(path);
    return parseMaquilaConfig(text);
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return { version: 1 };
    if (
      error instanceof Error &&
      (error.message === "invalid maquila config" ||
        error.message === "invalid Linear token reference" ||
        error.message === "invalid OpenRouter token reference")
    )
      throw error;
    throw new Error("invalid maquila config", { cause: error });
  }
}

export function writeMaquilaConfig(
  config: MaquilaConfig,
  options: { env?: NodeJS.ProcessEnv; homedir?: typeof defaultHomedir; target?: string } = {},
): string {
  if (!Value.Check(MaquilaConfigSchema, config)) throw new Error("invalid maquila config");
  const path = maquilaConfigPath(options.env, options.homedir);
  assertConfigOutsideTarget(path, options.target);
  const directory = resolve(path, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("invalid maquila config directory");
  chmodSync(directory, 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(config)}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return path;
}

function record(value: unknown): value is { code?: unknown } {
  return value !== null && typeof value === "object";
}
