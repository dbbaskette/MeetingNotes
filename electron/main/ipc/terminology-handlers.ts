import type { IpcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from './contracts.js';
import { TermInputSchema } from '../storage/terminology-repo.js';
import type { TerminologyService } from '../terminology/service.js';

const id = z.string().min(1).max(200);
const target = z.object({
  meetingId: id,
  artifact: z.enum(['summary', 'transcript']),
  source: z.string().max(80).optional(),
  replacement: z.string().max(80).optional(),
});
export function registerTerminologyHandlers(ipc: IpcMain, service: TerminologyService): void {
  ipc.handle(IPC_CHANNELS.terminologyList, () => service.repo.list());
  ipc.handle(IPC_CHANNELS.terminologySave, (_e, raw: unknown, ruleId: unknown) =>
    service.repo.save(
      TermInputSchema.parse(raw),
      ruleId === undefined ? undefined : id.parse(ruleId),
    ),
  );
  ipc.handle(IPC_CHANNELS.terminologyDelete, (_e, ruleId: unknown) =>
    service.repo.delete(id.parse(ruleId)),
  );
  ipc.handle(IPC_CHANNELS.terminologyOffers, (_e, enabled: unknown) =>
    service.repo.offers(enabled === undefined ? undefined : z.boolean().parse(enabled)),
  );
  ipc.handle(IPC_CHANNELS.terminologyPreview, (_e, input: unknown) =>
    service.preview(target.parse(input)),
  );
  ipc.handle(IPC_CHANNELS.terminologyCommit, (_e, input: unknown) =>
    service.commit(
      target
        .extend({
          revision: z.string().length(64),
          keys: z.array(z.string().max(300)).min(1).max(2000),
          dismiss: z.boolean().optional(),
        })
        .parse(input),
    ),
  );
  ipc.handle(IPC_CHANNELS.terminologyUndo, (_e, input: unknown) => {
    const p = z
      .object({
        meetingId: id,
        artifact: z.enum(['summary', 'transcript']),
        historyId: id,
        revision: z.string().length(64),
      })
      .parse(input);
    return service.undo(p.meetingId, p.artifact, p.historyId, p.revision);
  });
}
