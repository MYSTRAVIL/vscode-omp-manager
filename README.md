# OMP Session Manager

A VS Code sidebar for [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`), the terminal coding agent.

- **Usage limits.** Shows the output of `omp usage` per provider, with a countdown and the local reset time. Optional status bar item and a warning when a limit gets close.
- **Session history.** Lists your omp sessions for the current workspace, or all of them, grouped by date or folder. Click one to resume it in a terminal.
- **Live status.** Each open session shows whether it is idle, working, or waiting on your answer. Notifies you, in VS Code or through the OS, when a background session finishes or asks a question.
- **Restore on startup.** Reopens the omp sessions that were open when VS Code closed, in the same tab order. Can ask first.
- **Context menu.** Open in editor or panel, copy the session id or file path, reveal the session file, delete a closed session.

## Requirements

- VS Code 1.90 or later.
- `omp` on your `PATH`, or its absolute path in `omp.executable`.

## Install

No Marketplace release yet. Build the vsix and install it:

```sh
npm install
npm run compile
npm run package
code --install-extension omp-manager-0.1.0.vsix
```

## How it works

The extension launches every omp with `-e <extension>/hook/vscode-session-restore.ts`. That omp extension writes a small record to `<agentDir>/vscode-terminals/` when a session starts or switches, and when the agent starts working, stops, or asks a question. The sidebar reads those records to map terminals to sessions and to show status.

To get status and restore for omp started by hand in a VS Code shell terminal, copy `hook/vscode-session-restore.ts` into your omp extensions directory (`~/.omp/agent/extensions/`). Loading it twice is harmless.

Tab titles come from omp itself. Set `terminal.integrated.tabs.title` to include `${sequence}` to see them; the default shows only `omp`.

## Keybindings

| Keys | Command |
| --- | --- |
| `Ctrl+Alt+O` `N` | New Session |
| `Ctrl+Alt+O` `R` | Resume Session |
| `Ctrl+Alt+O` `W` | Focus Next Session Needing Input |

On macOS, use `Cmd` instead of `Ctrl`.

## Settings

### Launch

| Setting | Default | Description |
| --- | --- | --- |
| `omp.executable` | `omp` | omp executable name or absolute path. |
| `omp.agentDir` | empty | omp agent directory. Empty uses `PI_CODING_AGENT_DIR`, then `~/.omp/agent`. |
| `omp.extraArgs` | `[]` | Extra arguments for every omp the extension launches, for example `["--model", "sonnet"]`. |
| `omp.env` | `{}` | Extra environment variables for every omp the extension launches. |
| `omp.newSessionCwd` | `workspaceRoot` | Where New Session starts: `workspaceRoot`, `activeFileFolder`, or `ask`. |
| `omp.terminalLocation` | `editor` | Open sessions in the `editor` area or the `panel`. |
| `omp.terminalIcon` | `sparkle` | Codicon id for omp terminal tabs. |
| `omp.terminalColor` | empty | Theme color id for omp terminal tabs, for example `terminal.ansiMagenta`. |
| `omp.restoreOnStartup` | `always` | Reopen the sessions that were open when VS Code closed: `always`, `ask`, or `never`. |

### Usage

| Setting | Default | Description |
| --- | --- | --- |
| `omp.usage.refreshMinutes` | `5` | Refresh interval while the sidebar or status bar item shows usage. |
| `omp.usage.warnPercent` | `80` | Percent at which a meter turns to the warning color. |
| `omp.usage.providers` | `[]` | Providers to show. Empty shows all. |
| `omp.usage.resetDisplay` | `both` | Show the reset as a `countdown`, the local `time`, or `both`. |
| `omp.usage.statusBar` | `false` | Show the most-used limit in the status bar. |
| `omp.usage.notifyOnWarn` | `true` | Notify once per reset window when a limit reaches the warn percent. |

### Sessions

| Setting | Default | Description |
| --- | --- | --- |
| `omp.sessions.scope` | `workspace` | List sessions from the open workspace, or `all`. |
| `omp.sessions.maxShown` | `300` | Most sessions listed. Open sessions always show. |
| `omp.sessions.showEmpty` | `false` | List sessions that have no prompt yet. |
| `omp.sessions.sortBy` | `modified` | Sort newest first by `modified` or `created`. |
| `omp.sessions.groupBy` | `date` | Group the list by `date`, by `folder`, or not at all (`none`). Open sessions always come first. |

### Notifications

These are VS Code notifications from this extension, separate from omp's own.

| Setting | Default | Description |
| --- | --- | --- |
| `omp.notify.onFinish` | `true` | Notify when a session finishes while its tab is not in view. |
| `omp.notify.onInput` | `true` | Notify when a session asks a question while its tab is not in view. |
| `omp.notify.minWorkSeconds` | `10` | Skip the finish notification for runs shorter than this. |
| `omp.notify.style` | `vscode` | `vscode`, `system` (OS notification with sound while VS Code is in the background), or `both`. |

## Development

```sh
npm install
npm run watch   # compile on change; press F5 in VS Code to launch an Extension Development Host
npm test        # unit tests with a vscode stub
```

## License

[MIT](LICENSE)
