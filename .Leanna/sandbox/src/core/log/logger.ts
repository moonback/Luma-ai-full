import { EventEmitter } from 'node:events';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogEntry {
  id: number;
  t: string;
  level: LogLevel;
  source: string;
  message: string;
}

/** In-memory ring buffer + subscribers (the Electron main process also mirrors entries to a file). */
export class Logger extends EventEmitter<{ entry: [LogEntry] }> {
  private readonly entries: LogEntry[] = [];
  private seq = 1;
  level: LogLevel = 'info';

  constructor(private readonly limit = 2000) {
    super();
  }

  log(level: LogLevel, source: string, message: string): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const e: LogEntry = { id: this.seq++, t: new Date().toISOString(), level, source, message };
    this.entries.push(e);
    if (this.entries.length > this.limit) this.entries.shift();
    this.emit('entry', e);
  }
  debug(source: string, m: string) { this.log('debug', source, m); }
  info(source: string, m: string) { this.log('info', source, m); }
  warn(source: string, m: string) { this.log('warn', source, m); }
  error(source: string, m: string) { this.log('error', source, m); }

  recent(n = 300): LogEntry[] {
    return this.entries.slice(-n);
  }
}
