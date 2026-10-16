# Golden Gate 1.17.0 verification

Scope: approved visual design across the existing Electron app and a portable,
locally installed stack-neutral Golden Gate skill. No data/schema/processing
changes, installed-app replacement, active capture or real service calls.

## Evidence record

Targeted evidence: all 42 appearance-token contrast tests pass, main renderer
and fixture type checks pass, production build and whole-repository lint pass.
The isolated appearance fixture passes on the host with synthetic data across
five screens, two themes and two sizes, plus dialog/source-picker interaction
and emulated reduced effects/focus styles. Screenshots were inspected.

The portable and installed skill pass the official validator, YAML discovery
and local-reference checks; the two copies match exactly. Manual routing review
covers a web restyle, native restyle, review-only request and unrelated request:
the skill preserves stack/scope and does not authorize publication by itself.

Full Tart results, final source and signed artifact identity will be recorded
before publication. Existing 1.16.0 and 1.15.0 installers remain for rollback.

## Acceptance boundaries

- Isolated renderer checks use synthetic data, not the installed app or library.
- CSS material is not native OS glass; opaque/reduced-effects behavior is tested.
- Existing virtualization and scroll owners are preserved.
- No installer VM acceptance, actual capture or inference is requested/claimed.
