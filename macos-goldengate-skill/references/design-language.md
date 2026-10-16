# Visual language

## Integrated structure

Golden Gate is a refinement of the Mac's productivity UI, not maximal transparency. The composition should explain where navigation ends and content begins. Distinct regions can share an edge and a hairline divider without acquiring their own rounded frames or shadows.

Start with the existing task model. A source list belongs in a sidebar when it actually provides persistent navigation; inline expandable groups can remain inline. A website should remain a website, not acquire fake system menus, window controls or a desktop frame. In a desktop-window mockup, identify simulated chrome as presentation rather than working OS controls.

Before adding a boundary, ask what it explains. Keep meaningful discrete objects, selection, drag targets, validation or transient surfaces. Ordinary lists and forms usually need shared surfaces and spacing, not nested card outlines. Do not mechanically delete every card: object boundaries can be useful and changing them must not obscure click/selection/drag affordances.

## Material hierarchy

| Region | Recommended treatment |
| --- | --- |
| Main reading/data plane | Stable, quiet and usually opaque; avoid blur over body text |
| Navigation and optional inspector | Subordinate material or neutral surface with a clear shared boundary |
| Unified toolbar, search, compact commands | Restrained diffusion, legible text, small highlights and edges |
| Menus, popovers and sheets | One elevated material surface, with focus and dismissal behavior |
| Hover/selection/focus | State treatment, not a permanent card template |

Do not put glass behind every row or add floating bars inside content when the application already has a toolbar. A preview can suggest material using CSS; it must not imply physical refraction, OS-controlled tint or inactive-window behavior that the implementation does not provide.

## Tokens and appearance

Use semantic roles rather than a mandatory fixed palette. A starting light theme could use a cool neutral canvas, slightly lighter opaque content, diffused near-neutral chrome, dark slate text and the product's existing accent. A dark theme needs independent material/text pairs, not a global opacity reduction or inversion.

Use accent for selection, progress and a small number of important commands. Use informative icon colors without turning all peer regions into different-colored tiles. Status is also expressed in text or shape. Preserve brand colors unless the user asks for a change.

Prefer the platform's system text where available, with a deliberate hierarchy and useful density. On the web, use a cross-platform system-font stack rather than downloading or redistributing Apple's proprietary fonts. Do not shrink content until it fits; reflow, overflow commands appropriately or use existing pane-collapse behavior.

Corner dimensions are not universal: component radii, spacing and density depend on the framework, screen and control. Use tighter, coordinated corners and reserve more rounded shapes for compact controls/transient surfaces. Avoid a capsule around every icon and an inner rounded window around the application.

## State and access

Check populated, empty, loading and failure states without moving controls unexpectedly. Text, selected state, focus, important actions and pane ownership must remain understandable when transparency and motion are reduced. Motion should respond to an action rather than play continuously.

Use the target's real support for Reduce Transparency, Increase Contrast, Reduce Motion, appearance and inactive windows. Where an environment cannot observe a preference, choose a readable opaque fallback or existing app preference; never claim automatic OS integration without it. Keep programmatic labels, focus order and keyboard behavior intact.

## Final critique

Remove the material effects mentally: does the interface still make sense? If not, fix structure. Then remove one unnecessary wrapper or effect rather than adding another to solve the contrast problem.
