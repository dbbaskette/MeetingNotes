# Golden Gate UI refresh — approved implementation

The user approved the Golden Gate Library mockup and requested application to
all screens, followed by push, PR, merge, release notes and a new installer.

## Contract

- Preserve recording, processing, selection, inline expandable groups, saved
  reports, settings, dialogs, keyboard access and existing scroll ownership.
- Use cool neutral canvas, opaque reading surfaces, restrained diffused chrome,
  flatter group rows, clear selection, coordinated controls and system typography.
- Cover Library, detail/transcript/notes/actions/speakers, Weekly, Settings,
  onboarding, search, menus and dialogs in light and dark appearances.
- This is CSS-based Golden Gate-inspired material, not native OS Liquid Glass.
  Opaque, increased-contrast and reduced-motion fallbacks remain usable.
- Complete/install the reusable stack-neutral skill at macos-goldengate-skill/.
- Release 1.17.0. No data migrations, user-library edits, recording/inference,
  installed-app replacement or restart. Source-only GitHub release; local arm64
  DMG/ZIP, retaining older installers. No installer VM acceptance requested.

## Increments and verification

1. Validate skill metadata/references and installed copy.
2. Shared semantic tokens and shell, Library content, then all other screens
   and overlays. Preserve virtualized row sizing/measurement.
3. Add isolated synthetic appearance/interaction coverage and inspect rendered
   views at desktop/narrow widths, light/dark and reduced effects.
4. Update README, release notes and version. Run the existing full Tart suite
   against committed source; retain logs and report the tested tree.
5. Build/sign local installer, verify artifact version/signatures and source
   startup without affecting the installed app. Push, PR, merge after gates;
   publish source-only release and retain final provenance/verification notes.
