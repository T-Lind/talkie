type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
const threshold = ORDER[configured] ?? ORDER.info;

function write(level: Level, event: string, data?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const line = {
    time: new Date().toISOString(),
    level,
    event,
    ...(data ?? {}),
  };
  const output = JSON.stringify(line);
  if (level === 'error' || level === 'warn') console.error(output);
  else console.log(output);
}

export const logger = {
  debug: (event: string, data?: Record<string, unknown>) => write('debug', event, data),
  info: (event: string, data?: Record<string, unknown>) => write('info', event, data),
  warn: (event: string, data?: Record<string, unknown>) => write('warn', event, data),
  error: (event: string, data?: Record<string, unknown>) => write('error', event, data),
};
