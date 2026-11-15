/** The reading plans that were started, on this device. */
export interface PlanEntry {
  id: string;
  name: string;
  start: string;
  days: number;
  created: number;
  taskIds: string[];
  goalIds: string[];
}

const KEY = "reader:bible:plans";

export function loadPlans(): PlanEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function savePlans(list: PlanEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* not remembered */
  }
}
