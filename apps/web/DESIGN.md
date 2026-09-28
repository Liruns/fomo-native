# OmO Web Design System

## 1. Atmosphere & Identity

A compact, quiet coding workspace. The supplied light OmO screenshot is the visual contract: pale neutral navigation, a white conversation canvas, thin gray separators, small monochrome icons, and blue/green work-state indicators. Preserve live controls and existing data behavior, not the reference's sample conversation. OmO is the wordmark; the adjacent uppercase stage pill identifies DEV or the deployed channel. Desktop and mobile are real responsive surfaces, not scaled images.

## 2. Color

The default light palette is mirrored in `src/index.css` and `packages/shared/src/themePalettes.ts`. Existing stored themes, dark mode, and custom palette overrides remain selectable.

| Role                 | CSS token                                     | Light                | Dark                          |
| -------------------- | --------------------------------------------- | -------------------- | ----------------------------- |
| Canvas               | --background                                  | #ffffff              | existing neutral-950          |
| Chrome/sidebar       | --sidebar                                     | #f3f3f5              | existing dark sidebar         |
| Raised surface       | --card                                        | #ffffff              | existing dark card            |
| Primary ink          | --foreground                                  | zinc-800             | neutral-100                   |
| Secondary ink        | --muted-foreground                            | zinc-500             | existing dark muted ink       |
| Borders              | --border / --sidebar-border                   | zinc-200             | existing dark borders         |
| Sidebar input        | --sidebar-control-surface                     | #ebebee              | existing dark muted surface   |
| Hover wash           | --sidebar-row-hover                           | #e9e9ec              | existing dark hover           |
| Active/selected wash | --sidebar-row-active / --sidebar-row-selected | #dedee3              | existing dark active/selected |
| Working              | --info-foreground                             | blue-700             | blue-400                      |
| Done                 | --success-foreground                          | emerald-700          | emerald-400                   |
| Focus / action       | --ring / --primary                            | existing blue action | existing dark blue action     |

Use semantic tokens in components. State uses an ink wash, glyph, or label, never a colored edge. Keyboard focus-visible rings remain visible. Disabled launcher cards use muted ink and their reason, not an active-looking border.

## 3. Typography

Keep the installed system sans stack (`-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `system-ui`, sans-serif) to match the reference and avoid a font download. Keep the existing system mono stack for technical values.

| Role                      | Token                    | Size / line-height      | Weight          |
| ------------------------- | ------------------------ | ----------------------- | --------------- |
| App UI, thread titles     | text-ui                  | 13px / 20px             | 400, unread 600 |
| Launcher title / controls | text-xs                  | 12px / 16px             | 500             |
| Descriptions / metadata   | text-2xs                 | 11px / 16px             | 400             |
| Stage / status            | text-3xs                 | 10px / 14px             | 500             |
| Existing page headings    | text-lg through text-2xl | existing Tailwind scale | 500-600         |
| Mobile prompt             | --font-size-prompt-touch | minimum 16px            | 400             |

Long thread titles truncate; card descriptions wrap on narrow screens rather than clip.

## 4. Spacing & Layout

Tailwind's 4px base spacing with existing half-steps is the spacing system. Compact rows are 32px, icons 12-16px, header 40px on the web, launcher cards minimum 64px with 12px padding, 8px grid gaps, launcher measure 28rem. Existing resizable sidebar default is 16rem; retain persisted widths. Launcher uses two equal minmax(0,1fr) columns. Mobile keeps the sidebar sheet and full-width right-panel sheet; the main workspace must not horizontally scroll.

Adopt StyleGallery's panel-layout contract (https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/panel-layout.md): each pane can shrink and retains source order. App shell is bounded by 100dvh. The sidebar ScrollArea owns project/thread scrolling; its header and footer stay fixed. The conversation timeline owns message scrolling. The launcher body alone owns overflow beneath its fixed tab bar. No body scrollbar is introduced.

## 5. Components

- **Button/Input/Tooltip/Kbd**: retain existing Base UI + CVA primitives and their variants. Use their documented sizes rather than restyling controls. Icon buttons have accessible names and tooltips; coarse-pointer hit areas remain enlarged.
- **OmOWordmark**: reusable currentColor SVG vector letters, not a raster replacement for UI. Sidebar uses the same identity alongside a small agent glyph and stage pill. Onboarding and assistant source badges share the wordmark.
- **SidebarThreadHeader**: full-width filled search field above the compact scope/new-thread toolbar. Search retains the current combobox, results, and clear action.
- **Sidebar project group**: disclosure chevron + project icon + truncated project name + thread count + new-thread action. A collapsed group hides its rows; project actions remain reachable. Existing settlement/snooze and thread menus remain supported.
- **Thread status**: Working spinner plus elapsed time in blue; Done check-circle in green only for unread completion. Pending approval/input and monitoring retain truthful labels. Compact group indicators omit text but retain accessible labels. Off-screen spinner work pauses through the existing visible-animation primitive.
- **Surface launcher card**: live button with icon and title on the first line, shortcut badge top-right, description below. Shared card anatomy for every action. Default/hover/focus/disabled states use semantic color tokens. Existing actions and letters B/T/F/D/P/L/A/M are retained; Workflow adds W and is unavailable until explicitly wired, showing Coming soon. Browser profile selection remains a sibling button rather than an invalid nested button.
- **ComposerSurface**: retain the existing rounded white card, subtle composer shadow, attachment/permission controls, model chip, round send/stop action. Keep the supplied full placeholder on the expanded composer; touch typography remains 16px to prevent zoom.

Existing components are the primitive state harness; validate their real rendered states in the app, not a parallel mock implementation.

## 6. Motion & Interaction

Retain established app interactions. No new decorative motion. Working uses the existing visible-animation-aware Spinner, respecting reduced motion. Hover uses immediate tonal feedback; keyboard focus uses the shared focus ring. Existing panel transitions retain their existing settings. New group disclosure is immediate, with aria-expanded; launcher letters never intercept a typing context or a modal/menu.

## 7. Depth & Surface

Mixed strategy faithful to reference: thin neutral borders for panes/cards; tonal sidebar row selection; soft existing composer shadow. `--control-radius` is 8px, `--radius` 10px with derived radii for shared controls, composer rounded-3xl. Launcher cards use rounded-lg. No extra texture, gradient, accent outlines, or atmospheric artwork is added to the default web header.

## 8. Accessibility Constraints & Accepted Debt

Target WCAG 2.2 AA for active text and controls. Keep names on every icon control, visible keyboard focus, existing mobile sheets and large touch targets. Disabled cards expose their reason and cannot fire click/letter actions. Status is communicated by both shape/text and color; elapsed ticks are hidden from the live region. Every rendered row can be reached by keyboard and long titles truncate without expanding the sidebar.

Scope boundary: the supplied screenshot depicts real historical data and a desktop-only browser surface; QA uses synthetic projects/threads in an isolated home and web availability rules. Device is retained in addition to the screenshot's eight cards so no existing action is removed. Workflow is deliberately unavailable per task until the integration lane wires it. No other visual or accessibility debt is accepted. Developer-tool package installation would require the out-of-scope monorepo lockfile and is not included. Independent oracle tooling and production Lighthouse availability must be reported explicitly rather than self-certified.
