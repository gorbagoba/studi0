// types for scripts/setup.mjs — the pure helpers its tests import
export const PORT_KEYS: Record<string, string>;
export const PORT_DEFAULTS: Record<string, number>;
export const PIP_PINS: { pkg: string; spec: string; want: (v: string) => boolean }[];
export function portBusy(port: number): Promise<boolean>;
export function pickFreePort(
  start: number,
  busy?: (port: number) => Promise<boolean>,
): Promise<number>;
export function parseEnvFile(text: string): Record<string, string>;
export function writeEnvFile(
  changes: Record<string, string | number>,
  opts?: {
    exists?: boolean;
    read?: (p: string) => string;
    write?: (p: string, t: string) => void;
  },
): void;
