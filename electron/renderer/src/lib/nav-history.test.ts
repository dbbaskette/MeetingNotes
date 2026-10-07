import { describe, it, expect, vi } from 'vitest';
import { createNavHistory, viewsEqual } from './nav-history';

type V = { kind: 'library' | 'weekly' | 'settings' } | { kind: 'detail'; id: string };

const library: V = { kind: 'library' };
const weekly: V = { kind: 'weekly' };
const detail = (id: string): V => ({ kind: 'detail', id });

function make(initial: V = library) {
  const history = createNavHistory<V>(initial, { equal: viewsEqual });
  return { history };
}

describe('nav-history', () => {
  it('starts at the initial entry', () => {
    const { history } = make();
    expect(history.current()).toEqual(library);
    expect(history.canBack()).toBe(false);
    expect(history.canForward()).toBe(false);
  });

  it('pushes entries and walks back/forward', async () => {
    const { history } = make();
    await history.navigate(weekly);
    await history.navigate(detail('m1'));
    expect(history.current()).toEqual(detail('m1'));

    await history.back();
    expect(history.current()).toEqual(weekly);
    await history.back();
    expect(history.current()).toEqual(library);
    expect(history.canBack()).toBe(false);

    await history.forward();
    expect(history.current()).toEqual(weekly);
  });

  it('back/forward respect bounds as no-ops', async () => {
    const { history } = make();
    await history.back(); // no-op at root
    await history.forward(); // no-op with no forward entries
    expect(history.current()).toEqual(library);
  });

  it('navigating after back truncates the forward stack', async () => {
    const { history } = make();
    await history.navigate(weekly);
    await history.navigate(detail('m1'));
    await history.back(); // cursor at weekly; m1 is "forward"
    await history.navigate(detail('m2')); // must discard m1
    expect(history.current()).toEqual(detail('m2'));
    expect(history.canForward()).toBe(false);
    await history.back();
    expect(history.current()).toEqual(weekly);
  });

  it('de-duplicates consecutive identical entries (viewsEqual)', async () => {
    const { history } = make();
    await history.navigate(library);
    await history.navigate({ ...library });
    await history.back();
    // Both navigations collapsed into the existing root — back is a no-op.
    expect(history.current()).toEqual(library);
    expect(history.canBack()).toBe(false);
  });

  it('treats same-meeting detail navigations as one entry, different meetings as two', async () => {
    const { history } = make();
    await history.navigate(detail('m1'));
    await history.navigate(detail('m1'));
    await history.back();
    expect(history.current()).toEqual(library);

    await history.forward();
    await history.navigate(detail('m2'));
    await history.back();
    expect(history.current()).toEqual(detail('m1'));
  });

  it('caps the retained entries (oldest drop off)', async () => {
    let n = 0;
    const next = (): V => detail(`m${++n}`);
    const history = createNavHistory<V>(library, { equal: viewsEqual, max: 3 });
    await history.navigate(next());
    await history.navigate(next());
    await history.navigate(next()); // stack now [m3? ...] — cap keeps last 3
    // Walk back to the oldest retained entry.
    for (let i = 0; i < 10 && history.canBack(); i++) await history.back();
    expect(history.current().kind).toBe('detail'); // library was evicted
  });

  describe('guard gating', () => {
    it('blocks navigation when the guard denies', async () => {
      const guard = vi.fn(async () => false);
      const history = createNavHistory<V>(library, { equal: viewsEqual, guard });
      await history.navigate(weekly);
      expect(guard).toHaveBeenCalledOnce();
      expect(history.current()).toEqual(library);
      expect(history.canForward()).toBe(false); // denied navigate pushes nothing
    });

    it('allows navigation when the guard approves', async () => {
      const history = createNavHistory<V>(library, {
        equal: viewsEqual,
        guard: async () => true,
      });
      await history.navigate(weekly);
      expect(history.current()).toEqual(weekly);
    });

    it('gates back and forward too', async () => {
      let allow = false;
      const history = createNavHistory<V>(library, {
        equal: viewsEqual,
        guard: async () => allow,
      });
      await history.navigate(weekly); // denied
      expect(history.current()).toEqual(library);

      allow = true;
      await history.navigate(weekly);
      await history.navigate(detail('m1'));

      allow = false;
      await history.back(); // denied — cursor stays
      await history.forward(); // denied — cursor stays
      expect(history.current()).toEqual(detail('m1'));

      allow = true;
      await history.back();
      expect(history.current()).toEqual(weekly);
    });

    it('does not move the cursor when the guard denies a back', async () => {
      let allow = true;
      const history = createNavHistory<V>(library, {
        equal: viewsEqual,
        guard: async () => allow,
      });
      await history.navigate(weekly);
      allow = false;
      await history.back();
      expect(history.current()).toEqual(weekly);
    });
  });

  it('reports changes through onChange', async () => {
    const onChange = vi.fn();
    const history = createNavHistory<V>(library, { equal: viewsEqual, onChange });
    await history.navigate(weekly);
    await history.navigate(weekly); // de-duped → still fires commit once
    await history.back();
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([weekly, weekly, library]);
  });
});
