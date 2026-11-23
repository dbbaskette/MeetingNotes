import type { IpcMain } from 'electron';
import { AskScopeSchema, IPC_CHANNELS } from './contracts.js';
import type { IpcServices } from './handlers.js';
import { askMeetings, type AskFilter } from '../ask/ask-service.js';
import { askEndpoint, describeAskScope, facetCandidates } from '../ask/ask-scope.js';
import type { AskResult } from '../../shared/ask.js';

/** "Ask your meetings": one question at a time per window, over the whole
 *  library, the meetings the ⌘K filters allow, or one meeting. A new
 *  question, an explicit cancel or the window closing stops the one in
 *  flight, so an abandoned question does not keep the model busy. Neither
 *  questions nor answers are stored or logged. */
export function registerAskHandlers(ipc: IpcMain, s: IpcServices): void {
  const inFlight = new Map<number, AbortController>();
  const observed = new WeakSet<object>();
  const stop = (senderId: number): void => { inFlight.get(senderId)?.abort(); inFlight.delete(senderId); };

  ipc.handle(IPC_CHANNELS.searchAsk, async (event, question: string, scopeInput?: unknown): Promise<AskResult> => {
    if (!s.askIndex) throw new Error('Asking across meetings is not available.');
    const scope = AskScopeSchema.optional().parse(scopeInput) ?? {};
    const senderId = event.sender.id;
    if (!observed.has(event.sender)) { observed.add(event.sender); event.sender.once('destroyed', () => stop(senderId)); }
    stop(senderId);
    const controller = new AbortController();
    inFlight.set(senderId, controller);
    const started = Date.now();
    try {
      const library = s.meetings.listAll();
      const filter: AskFilter = {};
      let scopeLabel: string | null = null;
      if (scope.meetingId) {
        filter.meetingId = scope.meetingId;
      } else if (scope.facets) {
        const facets = scope.facets;
        // The same "me" search resolves for the "my tasks" facet.
        const meId = s.settings.get('userSpeakerId');
        const me = { id: meId, name: meId ? s.speakers.findById(meId)?.displayName ?? null : s.settings.get('userName') ?? null };
        const candidates = facetCandidates(facets, library, s.meetings.facetedSearch(), me);
        if (candidates) filter.meetingIds = candidates;
        if (facets.content) filter.kind = facets.content;
        const speakerName = facets.speakerId ? s.speakers.findById(facets.speakerId)?.displayName ?? null : null;
        scopeLabel = describeAskScope(facets, candidates?.length ?? library.length, speakerName);
      }
      const result = await askMeetings({
        index: s.askIndex,
        meetings: () => library,
        chat: (input) => s.lmStudio.chat(input),
        ensureReady: (sig) => s.llmSupervisor.ensureReady(sig),
        model: () => s.settings.get('llmModel'),
        disableThinking: () => s.settings.get('disableThinking'),
        reasoningEffort: () => s.settings.get('reasoningEffort'),
      }, question, controller.signal, filter);
      // Never log the question or the answer: they are meeting content.
      s.logger.info('ask:done', { found: result.found, sources: result.sources.length, scoped: scope.meetingId ? 'meeting' : scopeLabel ? 'filtered' : 'library', ms: Date.now() - started });
      return { ...result, scopeLabel, endpoint: askEndpoint(s.settings.get('summaryProvider'), s.settings.get('lmStudioUrl')) };
    } finally {
      if (inFlight.get(senderId) === controller) inFlight.delete(senderId);
    }
  });

  ipc.handle(IPC_CHANNELS.searchAskCancel, (event) => { stop(event.sender.id); });
}
