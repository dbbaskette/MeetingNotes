import { describe, it, expect, vi } from 'vitest';
import { AutoProcessRecordings } from './auto-process.js';
function fixture(enabled = true) {
  const deps = { enabled: () => enabled, catalog: vi.fn(async () => ({ meeting: { id: 'm', status: 'pending', durationS: 10 } })),
    enqueue: vi.fn(), queued: vi.fn(), failed: vi.fn() };
  return { deps, service: new AutoProcessRecordings(deps) };
}
describe('new finalized native recording automation', () => {
  it('catalogs but never enqueues when default-off', async () => {
    const { deps, service } = fixture(false); await service.finalized('s', '/new.m4a');
    expect(deps.catalog).toHaveBeenCalledOnce(); expect(deps.enqueue).not.toHaveBeenCalled();
  });
  it('deduplicates completion even across simultaneous calls', async () => {
    const { deps, service } = fixture(); await Promise.all([service.finalized('s', '/new.m4a'), service.finalized('s', '/new.m4a')]);
    expect(deps.enqueue).toHaveBeenCalledOnce(); expect(deps.enqueue).toHaveBeenCalledWith('m'); expect(deps.queued).toHaveBeenCalledOnce();
  });
  it('leaves invalid/failed output recoverable and never enqueues already processed meetings', async () => {
    const { deps, service } = fixture(); deps.catalog.mockRejectedValueOnce(new Error('invalid'));
    await service.finalized('bad', '/bad.m4a'); expect(deps.failed).toHaveBeenCalledOnce();
    deps.catalog.mockResolvedValueOnce({ meeting: { id: 'm', status: 'done', durationS: 10 } });
    await service.finalized('done', '/done.m4a'); expect(deps.enqueue).not.toHaveBeenCalled();
  });
});
