import type Database from 'better-sqlite3';

export interface KeychainStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
/** Main-only encrypted repository; never a Settings key or a renderer read API. */
export class RemoteCredentials {
  constructor(private db: Database.Database, private storage: KeychainStorage, private platform = process.platform) {}
  private ready(): void {
    if (this.platform !== 'darwin' || !this.storage.isEncryptionAvailable()) {
      throw new Error('macOS Keychain is unavailable; remote credentials were not stored');
    }
  }
  private identity(endpoint: string, owner: string): string { return JSON.stringify([endpoint, owner]); }
  set(endpoint: string, owner: string, token: string): void {
    this.ready();
    if (token.length < 32 || token.length > 4096 || /[\r\n\s]/.test(token)) throw new Error('Invalid API token');
    this.db.prepare('INSERT INTO remote_credentials VALUES (?,?) ON CONFLICT(identity) DO UPDATE SET ciphertext=excluded.ciphertext')
      .run(this.identity(endpoint, owner), this.storage.encryptString(token));
  }
  get(endpoint: string, owner: string): string {
    this.ready();
    const row = this.db.prepare('SELECT ciphertext FROM remote_credentials WHERE identity=?').get(this.identity(endpoint, owner)) as { ciphertext: Buffer } | undefined;
    if (!row) throw new Error('Reconnect this remote server in Settings');
    return this.storage.decryptString(row.ciphertext);
  }
}
