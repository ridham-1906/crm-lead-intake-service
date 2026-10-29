import { pino, type LoggerOptions } from "pino";

const APP = "ep-lead-intake";
const nodeEnv = process.env.NODE_ENV || "development";
const level = process.env.LOG_LEVEL || (nodeEnv === "production" ? "info" : "debug");

const options: LoggerOptions = {
  level,
  base: { service: APP, env: nodeEnv },
  redact: ["authorization", "password", "refresh_token", "apiKey", "token"].flatMap((k) => [k, `*.${k}`]),
};

// Bare origin, since pino-loki appends /loki/api/v1/push; also drops any user:token@ in the URL.
function lokiHost(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    console.error("LOKI_URL is not a valid URL; logging to stdout only");
    return undefined;
  }
}

// stdout always; Grafana Loki too when LOKI_URL is set. Labels match ep-crm: app / env / level.
function createLogger() {
  const host = process.env.LOKI_URL ? lokiHost(process.env.LOKI_URL) : undefined;
  if (!host) return pino(options);
  return pino(
    options,
    pino.transport({
      targets: [
        { target: "pino/file", level, options: { destination: 1 } },
        {
          target: "pino-loki",
          level,
          options: {
            host,
            basicAuth: { username: process.env.LOKI_USERNAME ?? "", password: process.env.LOKI_PASSWORD ?? "" },
            labels: { app: APP, env: nodeEnv },
            batching: { interval: 2 },
            silenceErrors: true,
          },
        },
      ],
    }),
  );
}

export const log = createLogger();

// Drains buffered lines to the transports before exit, with a 2.5 s backstop.
export function flushLogs(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2500);
    log.flush(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Library errors carry request config (auth headers, bodies); log only the safe parts.
export function errInfo(err: unknown): { name: string; message: string; status?: unknown; code?: unknown; stack?: string } {
  if (!(err instanceof Error)) return { name: "Unknown", message: String(err) };
  const e = err as Error & { status?: unknown; code?: unknown };
  return { name: e.name, message: e.message, status: e.status, code: e.code, stack: e.stack };
}
