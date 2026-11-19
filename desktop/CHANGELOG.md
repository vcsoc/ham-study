# Changelog

## 0.2.9 (personal build)

- Keep both Welcome actions fully readable, with full-width touch targets on phones and scrolling on short screens.

## 0.2.8 (personal build)

- Welcome new users with a choice to download Piper or study without sound. Piper is the default engine; no voice pack downloads before opt-in.
- Refresh the in-app settings, information, cache, and theme icons.

## 0.2.7 (personal build)

- Optionally read an expanded explanation after its answer, using the answer voice.
- Pause or resume active reading with Space; use Up and Down to jump between questions.
- Default to the reference Linux window and sidebar sizes, without overriding saved sizes.

## 0.2.6 (personal build)

- Drag the sidebar divider to resize the study navigation. The sidebar width and normal Linux window size are restored on launch.
- Give categories, sections and questions distinct visual treatments, and show section and question counts.
- Use Ctrl+Plus or Ctrl+Minus to zoom the interface and Ctrl+0 to reset it.

## 0.2.5 (personal build)

- Browse the offline bank by CLARES category and section, with synchronized disclosure controls in the sidebar and study area.
- Search reveals matching questions inside collapsed groups. Read-aloud reveals each section as it reaches it.

## 0.2.4 (personal build)

- Use the answer itself to open and close its offline explanation, without repeating it or showing a separate "Explanation" control.

## 0.2.3 (personal build)

- Show bundled explanations directly in the study bank and in incorrect or unanswered test results. No browser or network is needed to read them; citation URLs are displayed as text.
- The private archive is supplied locally at build time and is not part of the repository.

## 0.2.2

- Click a study question or answer to open its explanation panel. Incorrect and unanswered test results, including saved results, show the same panel.
- Link directly to the matching CLARES annotated questions for external explanations, references and diagrams. CLARES content is not bundled. Two questions have original offline notes, including one absent from the current CLARES bank.

## 0.2.1

- On Linux, drag the native title bar to move Ham Study without holding Super.
- Hyprland users can load `hyprland/ham-study.lua` from their Hyprland Lua config with `dofile("/absolute/path/to/ham-study.lua")` to open Ham Study floating by default.
