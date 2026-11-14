/** Small window helpers the end-to-end tests call from outside (they cannot import the Tauri packages by name). */
export async function windowLabels(): Promise<string[]> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return (await WebviewWindow.getAll()).map((x) => x.label).sort();
}
export async function trayExists(): Promise<boolean> {
  const { TrayIcon } = await import("@tauri-apps/api/tray");
  return !!(await TrayIcon.getById("main"));
}
export async function selfWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}
export async function mainVisible(): Promise<boolean> {
  return (await selfWindow()).isVisible();
}
export async function hideSelf() {
  await (await selfWindow()).hide();
}
export async function showSelf() {
  await (await selfWindow()).show();
}
export async function closeSelf() {
  await (await selfWindow()).close();
}
export async function placeSelf(w: number, h: number, x?: number, y?: number) {
  const { LogicalSize, LogicalPosition } = await import("@tauri-apps/api/window");
  const win = await selfWindow();
  await win.setSize(new LogicalSize(w, h));
  if (x !== undefined && y !== undefined) await win.setPosition(new LogicalPosition(x, y));
}
