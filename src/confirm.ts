/**
 * A yes/no dialog that works inside the app.
 *
 * The obvious `window.confirm()` does not. Tauri's webview shims the global
 * onto the IPC command `plugin:dialog|confirm`, and tauri-plugin-dialog 2.7
 * no longer has one — confirm was folded into `message` with an OkCancel
 * button set. The global therefore fails with
 *
 *     ERROR: dialog.confirm not allowed. Command not found
 *
 * which is what a user hit deleting a map pack. It is not a permissions
 * problem and granting `dialog:allow-confirm` does not fix it: that identifier
 * is itself now just an alias for `allow-message`.
 *
 * The plugin's own `confirm()` calls `message` under the hood, which the
 * `dialog:default` set already grants — so going through the plugin API works
 * where the global does not. `alert()` was unaffected, since it maps straight
 * to `message`; only confirm broke, and it broke silently everywhere at once.
 *
 * Imported lazily so a browser build never pulls the plugin in at all.
 */
export async function confirmAction(message: string): Promise<boolean> {
  const inTauri = typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
  if (!inTauri) return window.confirm(message);
  const { confirm } = await import("@tauri-apps/plugin-dialog");
  return await confirm(message);
}
