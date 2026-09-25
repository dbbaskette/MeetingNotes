# Inline meeting groups in the Library

Status: approved interaction correction to the 1.12.3 groups feature. No publication is authorized by this design.

## Outcome

The Library defaults to an **Organized** view with named group headers and an Ungrouped header in the same scrollable list. A meeting appears exactly once, inside its assigned group or Ungrouped. Headers remain visible when collapsed. Expanding a header reveals that group's meetings; **View** focuses the Library on only that group, with a clear return to all groups. **All meetings** is a separate flat sortable view, not a duplicate section in Organized.

## Interaction

- A compact Organized/All meetings switch replaces the group-as-filter control in the Library header. New group remains available as a secondary action. The chosen mode and expanded section IDs persist locally; first use expands Ungrouped and leaves named groups collapsed. Creating a group reveals its new section.
- Each section header is a single calm hierarchy cue: chevron, name, total meeting count, View, and a menu for rename/delete on named groups. Meeting rows indent under the header. Empty groups stay visible and say what to do next. Group menus and existing row/detail/bulk Move actions remain the assignment path.
- Focusing a group uses the existing scoped paged list, status chips, sorting, and search. Recording started from that focus preselects the group; recording from the all-groups view defaults to Ungrouped.
- In Organized, status filters apply across every section. Inline search finds matches globally, groups them by assignment, and temporarily expands sections with matches; clearing search restores the user's expansion choices. All meetings stays a single flat list. Needs Attention, Weekly, and quick search remain global.
- Select all loaded means the rows currently loaded in expanded sections. Select all matching uses the full filtered universe, including collapsed sections; the label states the exact count. Selection is still a fixed ID snapshot.

## Constraints and visual direction

No database migration or file move is needed; reuse the existing one-group-per-meeting metadata and scoped page/search IPC. Lazy-load only expanded sections with a per-section Load more control, while the focused and flat All meetings views retain existing virtualization for deep lists. Preserve existing light/dark tokens: white/sunken surfaces, stone ink, and indigo for active actions. The group header's indentation and one quiet separator carry hierarchy; avoid a second card or sidebar system. Buttons expose expanded state and support keyboard focus, Enter/Space, and Escape where relevant.

Drag-and-drop, pinning/reordering groups, and multi-group membership are ideas for a separate iteration, not requirements of this correction.
