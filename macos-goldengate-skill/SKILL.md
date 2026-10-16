---
name: macos-golden-gate-design
description: Design, restyle, or review UI in the macOS Golden Gate / restrained Liquid Glass style, using the project's existing stack. Use for requests such as "design this to look like Golden Gate" across web, React, Electron, SwiftUI, AppKit, and other UI frameworks; no native rewrite is implied.
license: MIT
metadata:
  version: "1.0.0"
---

# Golden Gate UI design

Translate the Golden Gate visual language into the interface the user actually has. This is a design system, not a requirement to use Swift or to imitate a Mac desktop inside a website.

## Recognize the intent

"Make this look like Golden Gate", "macOS Golden Gate style", and "Golden Gate Liquid Glass" are sufficient direction. Infer the stack and product from the supplied context. Use the existing implementation and interaction model unless the user requests a structural change. A review asks for findings; a mockup asks for a preview; implementation asks for code. Do not silently escalate between them or publish/install/restart anything without authorization.

## The recognizable style

- **An integrated composition.** Title, navigation and commands belong to the application structure. Panes share boundaries; the window is not surrounded by another decorative app-shaped container.
- **Quiet content, expressive controls.** Put carefully diffused material on navigation, toolbar controls, search and transient surfaces. Keep meeting lists, documents, dense data, forms and reading regions visually stable.
- **Depth with restraint.** A subtle light-catching edge, darker material boundary and small shadow can communicate a real elevated control. Do not distribute blur, capsules and shadows across every row.
- **Hierarchy before effects.** Use alignment, system-like typography, spacing, selection and semantic surface changes. A selected item can have a rounded highlight without making every neighboring item a card.
- **Color with a job.** Use restrained neutral surfaces, a limited accent and informative icon/status color. Preserve the product's brand and recognizable identity; purple, blue, a wallpaper gradient and traffic lights are not requirements.
- **A coherent opaque version.** Reduced transparency, stronger contrast, inactive states and narrow layouts must retain the same hierarchy and functionality.

Read [the visual language](references/design-language.md) when making or reviewing a design. Then select only the relevant implementation reference:

- HTML/CSS, React, Vue, Electron, Tauri or another web-rendered shell: [web and cross-platform](references/web-and-cross-platform.md).
- SwiftUI/AppKit: [Apple-native implementation](references/apple-native.md).
- Other frameworks: apply the visual language using their real layout, material and accessibility primitives. Do not invent APIs or require a rewrite.
- Platform claims, SDK availability or an exact current component reference: consult [sources and provenance](references/sources.md). Check official documentation before promising platform behavior; the style should still work when that API is unavailable.

## Work from the actual product

1. Identify the primary task and existing screen structure. A one-line map is enough, for example `unified toolbar | inline expandable group list | detail view`. Do not add a sidebar just because a reference app has one.
2. Audit containers. Keep boundaries that explain selection, drag/drop, discrete objects, pane ownership or transient UI. Replace redundant wrappers with spacing, headings or separators. Preserve existing useful cards when their boundaries genuinely communicate object identity.
3. Choose a small token set: canvas, content, chrome/material, divider, text, accent and interaction states, with light/dark counterparts where applicable. Keep material tokens separate from content tokens.
4. Define a material map. Name the few surfaces receiving diffusion/elevation and the regions staying opaque. Use one material layer where possible; glass-on-glass is not a contrast strategy.
5. Apply the style in coherent slices. Shared shell and tokens first, then representative content and controls, then other screens and error/empty/loading states. Do not change data, workflow or information architecture for a cosmetic refresh.
6. Inspect the rendered result and exercise real controls. Validate a representative narrow width, keyboard focus and reduced effects; use the project's existing tests for behavior. Reuse evidence for unchanged source rather than repeating whole suites after every small edit.

Scale the process to the request. A small visual adjustment does not need a new design interview. Existing approval of a mockup authorizes its requested implementation; ask only when a new material choice or scope expansion is needed.

## Review questions

- Can someone identify navigation, current selection, primary action and primary content without the blur?
- Does the composition feel integrated, rather than a set of floating dashboard panels?
- Are the few rounded/material controls grouped by task, with readable edges and text?
- Are labels, important commands, status and keyboard focus visible in all required appearances?
- Does the layout remain usable with reduced transparency/motion, strong contrast, long labels and resizing?
- Are claims accurate: **native system material** only when using the OS implementation, **Golden Gate-inspired** for a browser approximation?

Report the implemented direction, the stack-specific translation, verification and meaningful limits. Keep mockup-only or review-only results clearly distinguished from app changes. Preserve the user's chosen output format instead of forcing a fixed report template.

## Provenance

Adapted from GitHub's MIT-licensed `macos-golden-gate-design`, broadened to stack-neutral design and existing-product constraints. Copyright and permission notice are in [LICENSE](LICENSE); original source, revision and adaptation notes are in [sources](references/sources.md).
