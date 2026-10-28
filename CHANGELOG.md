# Changelog

## 0.3.0

- Session transcripts that are symlinks are listed, as omp lists and resumes them. A link to a transcript that is already listed shows once, and a session folder that is itself a symlink is still skipped.
- The workspace session list also shows sessions from the same folders in the repository's other git worktrees, as omp's resume picker does, so a session moved with `/wt` stays listed.
- `omp.restoreContinuesTurns` (off by default) restores sessions with `omp --restore`, so a turn that VS Code closing or crashing cut off goes on, with its subagents. Sessions opened by hand still use `--resume`. Needs omp 18.10.3 or later.
- A session stays working when omp ends a turn it will continue: a goal or todo continuation, a queued steer, or a wait on its background jobs. These no longer show as idle or notify "finished".
- A session waiting on an interactive plan review shows as needing input and notifies like a question. A question now notifies even when the session was idle, since omp ends the turn before opening the review.
- A π button in the editor tab bar starts a new session. Hide it by right-clicking the tab bar.
- Accounts in the usage view collapse: click an account's header. A collapsed account shows its highest usage, and collapse is remembered.
- The pace marker has dark edges, so it shows on the yellow and red bars too.
- The OMP sidebar opens at startup instead of Explorer. VS Code restores the last active view per workspace, so new windows and folders would otherwise land on Explorer. Turn it off with `omp.focusOnStartup`.
- A session keeps its status when omp moves it to a new file, which omp does when another process holds the transcript, and after a branch.

## 0.2.0

- Usage meters show pacing: a marker where usage would be at an even pace through the window, and how far under or over that pace you are. Toggle with `omp.usage.showPace`.
- Session groups collapse: click a header, or use Left and Right on it. Each header shows its session count, and collapse is remembered. A search shows every match regardless.
- Folder groups have a `+` on hover that starts a session in that folder.
- A resumed session shows a hollow "starting" dot until omp reports, which can take several seconds on a large session.
- An `OMP` output channel logs each launch: terminal created, process started, and omp's first report, with timings.
- Restore waits at most 2s (was 10s) for each terminal's process before opening the next, and the missing-hook warning comes after 10s (was 20s), with a Show Log button.
- The first session scan no longer blocks the extension host; it reads files in chunks, and the resume picker shows a busy bar until it finishes.

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
