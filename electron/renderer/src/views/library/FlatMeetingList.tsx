// electron/renderer/src/views/library/FlatMeetingList.tsx
import type { ComponentProps } from 'react';
import { useMeetingsStore } from '../../store/meetings';
import { VirtualMeetingList } from '../../components/VirtualMeetingList';

/** The flat list is the only consumer of the store's `refreshing` flag (it
 *  gates auto load-more), so the subscription lives here instead of at the
 *  Library root. */
export function FlatMeetingList(props: Omit<ComponentProps<typeof VirtualMeetingList>, 'refreshing'>): JSX.Element {
  const refreshing = useMeetingsStore(state => state.refreshing);
  return <VirtualMeetingList {...props} refreshing={refreshing} />;
}
