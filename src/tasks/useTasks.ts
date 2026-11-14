import { useEffect, useState } from "react";
import type { Task } from "../core/types";
import { useNotesVersion } from "../notes/store";
import { tasksStore, version } from "./store";

/** Every task, re-read whenever tasks or notes change. */
export function useTasks(): Task[] {
  const notesVersion = useNotesVersion();
  const [tick, setTick] = useState(version);
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => tasksStore.subscribe(() => setTick(version)), []);
  useEffect(() => {
    let alive = true;
    tasksStore.all().then((t) => alive && setTasks(t));
    return () => {
      alive = false;
    };
  }, [tick, notesVersion]);
  return tasks;
}
