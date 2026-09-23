# Changelog

## Unreleased

- Usage meters show pacing: a marker where usage would be at an even pace through the window, and how far under or over that pace you are. Toggle with `omp.usage.showPace`.

## 0.1.1

- Sidebar content uses more of the width: 8px from the left edge, and the right edge lines up with the session list's scrollbar lane.
- The omp hook no longer leaves `.tmp` files behind or drops a status update when Windows blocks a file replace.
- Usage limit warnings are remembered across windows and restarts, so each limit warns once per reset window.

## 0.1.0

First release.

- Sidebar with usage limits from `omp usage`: countdown and local reset time, warning color, optional status bar item and warning notification.
- Session history for the workspace or all sessions, grouped by date or folder, with search and keyboard navigation.
- Live status for open sessions (idle, working, needs input), with VS Code or OS notifications when a background session finishes or asks a question.
- Restore the sessions that were open when VS Code closed, in tab order, with an option to ask first.
- Launch settings: extra arguments, environment variables, start folder, tab icon and color.
- Keybindings for New Session, Resume Session, and Focus Next Session Needing Input.
