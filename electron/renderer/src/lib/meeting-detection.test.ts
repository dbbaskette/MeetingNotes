import { describe, expect, it, vi } from 'vitest';
vi.mock('../ipc/client', () => ({ api: { meetingDetector: { onDetected: () => () => {} } } }));
import { createMeetingDetection, titleFromDetected, type Detected } from './meeting-detection';

const tab = (title: string | null): Detected => ({ source: 'browser-tab', platform: 'Google Meet', url: 'https://meet.google.com/abc-defg-hij', title, browserPid: 7, browserLabel: 'Chrome' });

describe('meeting detection store', () => {
  it('keeps the detected meeting across a view switch', () => {
    let emit: (d: Detected) => void = () => {};
    let subscriptions = 0;
    const store = createMeetingDetection((cb) => { subscriptions++; emit = cb; return () => { subscriptions--; }; });
    const library = store.subscribe(() => {});
    emit(tab('Weekly sync'));
    const other = store.subscribe(() => {}); // banner on another view mounts
    library();                               // Library's banner unmounts
    expect(subscriptions).toBe(1);
    expect(store.get()).toEqual(tab('Weekly sync'));
    store.clear();
    expect(store.get()).toBeNull();
    other();
    expect(subscriptions).toBe(0);
  });
});

describe('titleFromDetected', () => {
  it('uses the page title without the product suffix', () => {
    expect(titleFromDetected(tab('Q3 planning review - Google Meet'))).toBe('Q3 planning review');
    expect(titleFromDetected(tab('Meet – Design critique'))).toBe('Design critique');
    expect(titleFromDetected(tab('Budget sync | Microsoft Teams'))).toBe('Budget sync');
  });
  it('returns nothing when the title carries no meeting name', () => {
    expect(titleFromDetected(tab(null))).toBeUndefined();
    expect(titleFromDetected(tab('Google Meet'))).toBeUndefined();
    expect(titleFromDetected(tab('Zoom'))).toBeUndefined();
    expect(titleFromDetected(tab('https://meet.google.com/abc-defg-hij'))).toBeUndefined();
    expect(titleFromDetected({ source: 'native-app', appName: 'Zoom', bundleId: 'us.zoom.xos', pid: 3 })).toBeUndefined();
  });
});
