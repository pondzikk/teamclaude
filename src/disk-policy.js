import { normalizeCap } from './account-manager.js';

/**
 * Apply an account's operator policy fields from the on-disk config to the
 * running account on hot reload: the hard usage cap (`maxUtilization`) and the
 * `fallbackOnly` flag. Adding, changing and removing (a missing key) all apply.
 *
 * `memAcct` is the matching in-memory config entry (the TUI's saveConfig writes
 * it back over the disk entry). It is mirrored here so a TUI save after a disk
 * edit cannot resurrect a flag or cap the operator removed on disk.
 */
export function applyAccountPolicy(accountManager, mgrIdx, diskAcct, memAcct = null) {
  const mgr = accountManager.accounts[mgrIdx];
  if (!mgr) return;
  // A present-but-invalid cap never loosens protection: it keeps a working cap
  // in place, and blocks an account that had none (fails closed).
  const cap = normalizeCap(diskAcct.maxUtilization, diskAcct.name);
  const current = mgr.maxUtilization || null;
  if (cap?.invalid && current && !current.invalid) {
    console.error(`[TeamClaude] Keeping the previous usage cap ${JSON.stringify(current)} for "${mgr.name}" — the new value on disk is invalid`);
  } else if (JSON.stringify(cap) !== JSON.stringify(current)) {
    mgr.maxUtilization = cap;
    mgr.capLatch = null;
    mgr.overHardCap = false;
    console.log(`[TeamClaude] Usage cap for "${mgr.name}": ${cap ? JSON.stringify(cap) : 'removed'}`);
  }
  accountManager.setFallbackOnly(mgrIdx, diskAcct.fallbackOnly === true);
  accountManager.setMonthlyBudget?.(mgrIdx, diskAcct);

  if (memAcct) {
    for (const key of ['maxUtilization', 'fallbackOnly', 'monthlyBudget']) {
      if (diskAcct[key] === undefined) delete memAcct[key];
      else memAcct[key] = diskAcct[key];
    }
  }
}
