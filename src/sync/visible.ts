/** Cloud sync is a plugin in Settings → Plugins: off until switched on (on this device). */
const KEY = "reader:sync-on";
export const syncOn = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
export const setSyncOn = (on: boolean) => {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
};
