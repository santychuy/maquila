import { DEFAULT_OBSERVER_PORT } from "../observer.js";

export function rejectOptions(values: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([key]) => key)
    .filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`unsupported option for command: --${extra[0]}`);
}

export function parseObserverPort(value: string | undefined): number {
  const port = Number(value ?? process.env.FACTORY_OBSERVER_PORT ?? DEFAULT_OBSERVER_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("--port must be an integer from 1 to 65535");
  return port;
}

export function parseTimeout(value: string | undefined, fallback: string): number {
  const seconds = Number(value ?? fallback);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 1800)
    throw new Error("--timeout-seconds must be an integer from 1 to 1800");
  return seconds;
}
