import fs from 'node:fs';
import path from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private stream: fs.WriteStream;
  /** Absolute path of the log file on disk. Exposed so the IPC layer can
   *  tail it for the in-app Diagnostics view and reveal it in Finder. */
  readonly filePath: string;
  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
  }
  private write(level: Level, msg: string, data?: Record<string, unknown>): void {
    const entry = { ts: new Date().toISOString(), level, msg, ...(data ?? {}) };
    this.stream.write(JSON.stringify(entry) + '\n');
  }
  debug(msg: string, data?: Record<string, unknown>): void { this.write('debug', msg, data); }
  info(msg: string, data?: Record<string, unknown>): void { this.write('info', msg, data); }
  warn(msg: string, data?: Record<string, unknown>): void { this.write('warn', msg, data); }
  error(msg: string, data?: Record<string, unknown>): void { this.write('error', msg, data); }
  close(cb?: () => void): void { this.stream.end(cb); }
}
