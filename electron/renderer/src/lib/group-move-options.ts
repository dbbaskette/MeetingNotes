export interface GroupDestination { id: string | null; name: string }

/** Ungrouped is a destination, not a permanent shortcut outside the search. */
export function filteredMoveDestinations(
  groups: readonly { id: string; name: string }[], search: string,
): GroupDestination[] {
  const query = search.trim().toLocaleLowerCase();
  return [...groups.map(({ id, name }) => ({ id, name })), { id: null, name: 'Ungrouped' }]
    .filter((option) => option.name.toLocaleLowerCase().includes(query));
}
