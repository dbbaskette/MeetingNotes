import { describe, expect, it } from 'vitest';
import { filteredMoveDestinations } from './group-move-options';

const groups = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }];

describe('move destinations', () => {
  it('shows Ungrouped after named groups when not searching', () => {
    expect(filteredMoveDestinations(groups, '').map((option) => option.name))
      .toEqual(['Alpha', 'Beta', 'Ungrouped']);
  });

  it('does not leave Ungrouped as an unrelated click target during search', () => {
    expect(filteredMoveDestinations(groups, '  bet  ').map((option) => option.name)).toEqual(['Beta']);
    expect(filteredMoveDestinations(groups, 'ungroup').map((option) => option.name)).toEqual(['Ungrouped']);
  });
});
