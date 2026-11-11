import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from './contracts.js';
import type { IpcServices } from './handlers.js';
import { askMeetings } from '../ask/ask-service.js';

/** "Ask across meetings": one question at a time per window. A new question,
 *  an explicit cancel or the window closing stops the one in flight, so an
 *  abandoned question does not keep the local model busy. */
export function registerAskHandlers(ipc: IpcMain, s: IpcServices): void {
  const inFlight = new Map<number, AbortController>();
  const observed = new WeakSet<object>();
  const stop = (senderId: number): void => { inFlight.get(senderId)?.abort(); inFlight.delete(senderId); };

  ipc.handle(IPC_CHANNELS.searchAsk, async (event, question: string) => {
    if (!s.askIndex) throw new Error('Asking across meetings is not available.');
    const senderId = event.sender.id;
    if (!observed.has(event.sender)) { observed.add(event.sender); event.sender.once('destroyed', () => stop(senderId)); }
    stop(senderId);
    const controller = new AbortController();
    inFlight.set(senderId, controller);
    const started = Date.now();
    try {
      const result = await askMeetings({
        index: s.askIndex,
        meetings: () => s.meetings.listAll(),
        chat: (input) => s.lmStudio.chat(input),
        ensureReady: () => s.llmSupervisor.ensureReady(),
        model: () => s.settings.get('llmModel'),
        disableThinking: () => s.settings.get('disableThinking'),
      }, question, controller.signal);
      // Never log the question or the answer: they are meeting content.
      s.logger.info('ask:done', { found: result.found, sources: result.sources.length, ms: Date.now() - started });
      return result;
    } finally {
      if (inFlight.get(senderId) === controller) inFlight.delete(senderId);
    }
  });

  ipc.handle(IPC_CHANNELS.searchAskCancel, (event) => { stop(event.sender.id); });
}
