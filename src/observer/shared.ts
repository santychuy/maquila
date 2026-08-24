export const OBSERVER_VERSION = 1;
export const DEFAULT_OBSERVER_PORT = 4600;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ObserverDescriptor {
  version: 1;
  instanceId: string;
  pid: number;
  processIdentity?: string;
  port: number;
  url: string;
  startedAt: string;
}
export interface ObserverInfo extends ObserverDescriptor {
  running: true;
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}
