import React from 'react';
import {createRoot} from 'react-dom/client';
import '../../electron/renderer/src/index.css';
const fixture = {saves: [] as {key: string; value: unknown}[], fail: false, restored: '', chosen: '/fixture/chosen'};
(window as any).fixture = fixture;
window.api = {
  settings: {getAll: async () => ({summaryProvider: 'external',summaryDetail: 'standard',lmStudioUrl: 'http://localhost:1234',llmModel: 'fixture-model',disableThinking: true,sttUrl: 'http://localhost:8080',sttModel: 'fixture',sttLanguage: 'en',libraryPath: '/fixture/library',audioWatchPath: '',userName: 'Dan',userSpeakerId: null,theme: 'system',recordingBitrateKbps: 128,autoDetectMeetings: {browserTabs: false,nativeApps: false,silenceMs: 5000},autoRecordZoom: false,exporterWebhook: false,googleClientId: '',googleClientSecret: ''}),
    set: async (key: string,value: unknown) => {fixture.saves.push({key,value}); if(fixture.fail) throw new Error('Fixture save failed'); return value;},chooseFolder: async () => fixture.chosen},
  models: {list: async () => []},permissions: {audio: async () => ({mic: 'granted',audioCapture: 'granted'})},speakers: {list: async () => []},
  llm: {detectProviders: async () => ({lmStudio: {binary: false,running: false},ollama: {binary: false,running: false}})},
  terminology: {list: async () => [],offers: async () => true},groups: {list: async () => ({groups: [],ungroupedCount: 0})},
  obsidian: {status: async () => ({config: null,running: false,lastSuccess: null,error: null,pending: 0,synced: 0,issues: []})},
  google: {authStatus: async () => ({signedIn: false,email: null,hasCredentials: false})},logs: {tail: async () => ({path: '/fixture/log',entries: []})},
  notesHistory: {list: async () => [{id: 'version',createdAt: '2026-10-06T10:00:00Z',reason: 'Before notes changed'}],compare: async () => ({revision: 'fingerprint',current: {id: '',summary: 'Current notes',items: []},previous: {id: 'version',summary: 'Old notes',items: [{id: 'task',text: 'Completed original task',status: 'done',ownerName: 'Dan',dueDate: null}]}}),restore: async () => {fixture.restored='Old notes';}},
} as any;
const {SettingsView} = await import('../../electron/renderer/src/views/SettingsView');
const {NotesHistory} = await import('../../electron/renderer/src/components/NotesHistory');
createRoot(document.getElementById('root')!).render(<div style={{height: '100vh'}}>
  <SettingsView onNav={() => {}}/><div style={{position: 'fixed',bottom: 8,right: 8}}><NotesHistory meetingId="m" disabled={false} onRestored={async summary => {fixture.restored=summary;}}/></div>
</div>);
