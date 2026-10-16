# SwiftUI and AppKit

Use real native structure where the app already uses SwiftUI/AppKit. Do not replace the framework's standard behavior with a hand-drawn browser-style shell.

- SwiftUI: begin with the application's existing scenes, `NavigationSplitView`, `List`, `Table`, `Form`, toolbar, search, inspector and standard presentations as appropriate to the task.
- AppKit: preserve standard windows, split views, toolbars, source lists/outline views, tables, menus and sheets.
- Use native semantic colors, typography, materials and state handling. Let the OS own control metrics, focus, inactive-window adaptation and supported personalization.
- A custom glass effect is for a real custom control or surface the standard components cannot express. Keep long-form content and data regions stable.

Consult installed SDK declarations and official docs for the exact Liquid Glass API and availability. Guard newer APIs and use a readable standard material/opaque fallback when supporting earlier systems. Building with a newer SDK does not itself authorize raising the deployment target. Do not guess an API based on a screenshot or hard-code measurements from a Figma reference as universal system dimensions.

Keep sidebar/inspector collapse and resize behavior, toolbar overflow, native menu commands, VoiceOver and keyboard navigation. Verify light/dark, active/inactive, compact/default/wide, Reduce Transparency, Increase Contrast and Reduce Motion to the degree relevant to the changed surface. Report untested combinations rather than treating one static preview as native acceptance.
