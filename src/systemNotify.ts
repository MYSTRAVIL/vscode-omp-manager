import { execFile } from "node:child_process";

// Windows PowerShell 5.1 ships with every Windows 10/11 and can raise WinRT toasts.
// Text arrives through the environment so no quoting reaches the script. The toast posts
// under the Start menu app id of the running editor (VS Code, Insiders, or a fork), so it
// shows that app's name and icon; PowerShell's id, registered for every user, is the fallback.
const WINDOWS_SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$text = $xml.GetElementsByTagName('text')
$text.Item(0).AppendChild($xml.CreateTextNode($env:OMP_NOTIFY_TITLE)) > $null
$text.Item(1).AppendChild($xml.CreateTextNode($env:OMP_NOTIFY_BODY)) > $null
$audio = $xml.CreateElement('audio')
$audio.SetAttribute('src', 'ms-winsoundevent:Notification.Default')
$xml.DocumentElement.AppendChild($audio) > $null
$app = Get-StartApps | Where-Object { $_.Name -eq $env:OMP_NOTIFY_APP } | Select-Object -First 1
$appId = if ($app) { $app.AppID } else { '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe' }
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;

// argv keeps the text out of the AppleScript source.
const MAC_SCRIPT = `on run argv
display notification (item 2 of argv) with title (item 1 of argv) sound name "default"
end run`;

/**
 * Shows an operating system notification with its default sound. `appName` is the editor's
 * display name (`vscode.env.appName`), used to post under its identity where the OS allows.
 * Resolves false when it could not.
 */
export function systemNotify(appName: string, title: string, body: string): Promise<boolean> {
	return new Promise((resolve) => {
		const done = (err: Error | null) => resolve(!err);
		const opts = { timeout: 10_000, windowsHide: true };
		switch (process.platform) {
			case "win32":
				execFile(
					"powershell.exe",
					["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_SCRIPT],
					{ ...opts, env: { ...process.env, OMP_NOTIFY_APP: appName, OMP_NOTIFY_TITLE: title, OMP_NOTIFY_BODY: body } },
					done,
				);
				return;
			case "darwin":
				execFile("osascript", ["-e", MAC_SCRIPT, title, body], opts, done);
				return;
			default:
				execFile("notify-send", [`--app-name=${appName}`, title, body], opts, done);
		}
	});
}
