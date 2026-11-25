type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function writeLog(level: LogLevel, metaOrMsg: Record<string, unknown> | string, msg?: string): void {
  const timestamp = new Date().toISOString();
  const payload =
    typeof metaOrMsg === 'string'
      ? { level, timestamp, message: metaOrMsg }
      : {
          level,
          timestamp,
          message: msg ?? '',
          ...serializeErrors(metaOrMsg),
        };

  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function serializeErrors(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v instanceof Error) {
      out[k] = { name: v.name, message: v.message, stack: v.stack };
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const logger = {
  info: (metaOrMsg: Record<string, unknown> | string, msg?: string) => writeLog('info', metaOrMsg, msg),
  warn: (metaOrMsg: Record<string, unknown> | string, msg?: string) => writeLog('warn', metaOrMsg, msg),
  error: (metaOrMsg: Record<string, unknown> | string, msg?: string) => writeLog('error', metaOrMsg, msg),
  debug: (metaOrMsg: Record<string, unknown> | string, msg?: string) => writeLog('debug', metaOrMsg, msg),
};
