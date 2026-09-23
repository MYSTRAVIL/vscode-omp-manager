# OMP Session Manager

A VS Code sidebar for [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`), the terminal coding agent.

- **Usage limits.** Shows the output of `omp usage` per provider, with reset times. Refreshes while the view is visible.
- **Session history.** Lists your omp sessions for the current workspace. Click one to resume it in a terminal.
- **Live status.** Each open session shows whether it is idle, working, or waiting on your answer. Optionally notifies you when a background session finishes or asks a question.
- **Restore on startup.** Reopens the omp sessions that were open when VS Code closed, in the same tab order.
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

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `omp.executable` | `omp` | omp executable name or absolute path. |
| `omp.agentDir` | empty | omp agent directory. Empty uses `PI_CODING_AGENT_DIR`, then `~/.omp/agent`. |
| `omp.terminalLocation` | `editor` | Open sessions in the `editor` area or the `panel`. |
| `omp.restoreOnStartup` | `true` | Reopen the sessions that were open when VS Code closed. |
| `omp.usageRefreshMinutes` | `5` | Usage refresh interval while the view is visible. |
| `omp.notifyWhenDone` | `true` | Notify when a session whose tab is not in view finishes or asks a question. |

## Development

```sh
npm install
npm run watch   # compile on change; press F5 in VS Code to launch an Extension Development Host
npm test        # unit tests with a vscode stub
```

## License

[MIT](LICENSE)
