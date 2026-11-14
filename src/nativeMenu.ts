/**
 * The browser's own right-click menu (Back, Reload, Save as, Inspect…) has no place in the app. It stays where it helps:
 * in text boxes and editors, and on selected text (copy, paste, spelling). Shift + right-click always opens it, for debugging.
 */
export function limitNativeMenu() {
  window.addEventListener("contextmenu", (e) => {
    if (e.defaultPrevented || e.shiftKey) return;
    const el = e.target as HTMLElement | null;
    if (el?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true'], [data-native-menu]")) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    e.preventDefault();
  });
}
