let locked = false;
let mutations = 0;
let waiters: (() => void)[] = [];
export function backupIsLocked(): boolean {
  return locked;
}
export function assertBackupIdle(): void {
  if (locked)
    throw new Error('A Library backup is running. Wait for it to finish before making changes.');
}
export function assertNoLibraryMutations(): void {
  if (mutations)
    throw new Error('Wait for saving, export, or other Library work to finish before backing up.');
}
export function beginLibraryMutation(): () => void {
  assertBackupIdle();
  mutations++;
  return () => {
    mutations--;
  };
}
export async function waitForBackup(): Promise<void> {
  if (locked) await new Promise<void>((resolve) => waiters.push(resolve));
}
export function acquireBackup(): () => void {
  assertBackupIdle();
  locked = true;
  return () => {
    locked = false;
    const pending = waiters;
    waiters = [];
    pending.forEach((resolve) => resolve());
  };
}
