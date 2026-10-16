import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPreviewApi } from '../../electron/renderer/src/dev/preview-api';
import type { MeetingDetail } from '../../electron/renderer/src/views/MeetingDetailView';
import type { NavTarget } from '../../electron/renderer/src/components/AppNav';
import '../../electron/renderer/src/index.css';

// Only in-memory bridge data; never the app main, file audio or real services.
window.api = createPreviewApi();
const setMediaAttribute = HTMLMediaElement.prototype.setAttribute;
HTMLMediaElement.prototype.setAttribute = function (name, value) {
  if (name === 'src' && value.startsWith('file://')) return;
  setMediaAttribute.call(this, name, value);
};
const fixture = { captures: 0, preparations: 0 };
(window as any).fixture = fixture;
const groupId = '00000000-0000-4000-8000-000000000001';
const meeting: MeetingDetail = {
  id: 'design', title: 'Product planning — autumn release', groupId, groupName: 'Product & design',
  startedAt: '2026-10-15T14:00:00Z', durationS: 1800, pipelineStage: 'done', status: 'done',
  errorMessage: null, stageStartedAt: null, stageEtaMs: null, stageEtaRough: false,
  skipSpeakerId: false, userIdentified: true, audioPath: '', rawTranscriptText: null,
  transcriptMd: '[Alice 00:00] Let’s review the autumn release.\n[Bob 00:15] The prototype is ready for feedback.\n[Alice 00:32] We will share the revised design on Friday.',
  summaryMd: '## Overview\nThe team reviewed the autumn release and agreed to share the revised design on Friday.\n\n## Key discussion points\n- **Design:** simplify navigation while keeping familiar workflows.\n- **Quality:** verify accessibility and the narrow-window layout.\n\n## Decisions\n- Keep expandable meeting groups in the Library.\n\n## Next steps\n- Share the revised design for feedback.',
  speakers: [
    { localLabel: 'SPEAKER_00', rosterId: 'alice', displayName: 'Alice', confidence: 1 },
    { localLabel: 'SPEAKER_01', rosterId: 'bob', displayName: 'Bob', confidence: 1 },
  ],
  actionItems: [{ id: 'task', text: 'Share the revised design for feedback', ownerName: 'Bob',
    dueDate: null, status: 'open', exportedTo: [], sourceQuote: null, isMine: false }],
  models: { stt: 'Apple SpeechTranscriber', llm: 'local summary model' },
};
const rows = Array.from({ length: 8 }, (_, i) => ({ ...meeting, id: `design-${i}`, slug: `design-${i}`,
  title: i === 0 ? meeting.title : ['Customer feedback', 'Weekly product sync', 'Release readiness'][i % 3],
  groupId: i < 2 ? null : groupId, groupName: i < 2 ? null : meeting.groupName,
  actionItemsCount: 1, unidentifiedCount: 0,
}));
const counts = { all: 8, pending: 0, processing: 0, done: 8, failed: 0 };
window.api.groups.list = async () => ({ groups: [{ id: groupId, name: meeting.groupName!, count: 6 }], allCount: 8, ungroupedCount: 2 }) as any;
window.api.meetings.listPage = async query => {
  const items = rows.filter(row => query.groupId === undefined || row.groupId === query.groupId);
  return { items, total: items.length, nextCursor: null, counts } as any;
};
window.api.meetings.listIds = async filter => filter === 'all' || filter === 'done' ? rows.map(row => row.id) : [];
window.api.meetings.getMany = async ids => rows.filter(row => ids.includes(row.id)) as any;
window.api.meetings.get = async id => ({ ...meeting, id, transcriptMd: undefined, rawTranscriptText: undefined }) as any;
window.api.meetings.getTranscript = async () => ({ transcriptMd: meeting.transcriptMd, rawTranscriptText: null });
window.api.meetings.getSpeakerReview = async () => ({ speakers: meeting.speakers.map(sp => ({ ...sp,
  state: 'confirmed', needsReview: false, segmentCount: 12, durationS: 450, lineCount: 32,
})) }) as any;
window.api.meetings.getStatus = async () => meeting as any;
window.api.speakers.list = async () => [{ id: 'alice', displayName: 'Alice' }, { id: 'bob', displayName: 'Bob' }] as any;
window.api.speakers.suggestions = async () => [];
window.api.recording.start = async () => { fixture.captures++; throw Error('Capture forbidden in appearance fixture'); };
window.api.nativeSpeech.status = async () => ({ supported: true, appleReady: true, speakerReady: true, busy: false, phase: 'Ready', progress: 1, error: null }) as any;
window.api.nativeSpeech.prepare = async () => { fixture.preparations++; throw Error('Preparation forbidden in appearance fixture'); };
window.api.weekly.getStructured = async (year, week) => ({
  isoYear: year, isoWeek: week, rangeStart: '2026-10-12T00:00:00Z', rangeEnd: '2026-10-18T23:59:59Z',
  totalDurationS: 1800, inProgress: false, hasFreshCache: true, savedAt: '2026-10-16T12:00:00Z',
  meetings: [{ id: 'design', title: meeting.title, startedAt: meeting.startedAt, durationS: 1800,
    speakerCount: 2, highlight: 'Autumn release and accessible design review.' }],
  openActionGroups: [], openActionCount: 0,
}) as any;
window.api.weekly.getNarrative = async () => ({
  narrative: 'The team aligned on the autumn release and reviewed the updated design. Clear navigation and accessible reading surfaces remain the priorities.',
  themes: [{ title: 'Product quality', detail: 'Keep the familiar workflows and improve their clarity.', meetings: [meeting.title] }],
  decisions: ['Keep expandable groups in the Library.'], generatedAt: '2026-10-16T12:00:00Z', fromCache: true,
}) as any;
window.localStorage.setItem('libraryViewMode', 'organized');
window.localStorage.setItem('libraryExpandedGroups', JSON.stringify(['ungrouped', groupId]));
const { LibraryView } = await import('../../electron/renderer/src/views/LibraryView');
const { WeeklyView } = await import('../../electron/renderer/src/views/WeeklyView');
const { SettingsView } = await import('../../electron/renderer/src/views/SettingsView');
const { MeetingDetailView } = await import('../../electron/renderer/src/views/MeetingDetailView');
const { OnboardingView } = await import('../../electron/renderer/src/views/OnboardingView');
const { ToastHost } = await import('../../electron/renderer/src/components/Toasts');
function Fixture(): JSX.Element {
  const [view, setView] = useState<NavTarget | 'detail' | 'onboarding'>('library');
  (window as any).showView = setView;
  return <ToastHost><div className="window-drag-strip" /><div className="h-full flex flex-col">
    {view === 'library' ? <LibraryView onOpen={() => setView('detail')} onNav={setView}
      onOpenSearch={() => {}} liveRecording={null} onStartRecording={() => {}} onRecordingStopped={() => {}} />
      : view === 'weekly' ? <WeeklyView onNav={setView} onOpenMeeting={() => setView('detail')} />
      : view === 'settings' ? <SettingsView onNav={setView} />
      : view === 'onboarding' ? <OnboardingView onFinished={() => setView('library')} />
      : <MeetingDetailView id="design" onBack={() => setView('library')} />}
  </div></ToastHost>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
