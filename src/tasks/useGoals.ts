import { useEffect, useState } from "react";
import { goalStore, goalVersion, type GoalData } from "./goalStore";
import { version } from "./store";

const EMPTY: GoalData = { goals: [], links: [] };

/** Goals and links, re-read whenever goals change (or tasks were deleted, which removes their links). */
export function useGoals(): GoalData {
  const [tick, setTick] = useState(goalVersion);
  const [data, setData] = useState<GoalData>(EMPTY);
  useEffect(() => goalStore.subscribe(() => setTick(goalVersion)), []);
  useEffect(() => {
    let alive = true;
    goalStore.all().then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, [tick]);
  void version;
  return data;
}
