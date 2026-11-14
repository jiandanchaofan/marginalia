import { useEffect, useMemo, useState } from "react";
import type { NoteLink } from "../core/types";
import { notesStore, useNotesVersion, type NoteHit } from "./store";

/** Every link between notes, refreshed whenever notes or links change. */
export function useLinks(): NoteLink[] {
  const v = useNotesVersion();
  const [links, setLinks] = useState<NoteLink[]>([]);
  useEffect(() => {
    let alive = true;
    notesStore.links().then((l) => alive && setLinks(l));
    return () => {
      alive = false;
    };
  }, [v]);
  return links;
}

/** The notes with these ids (for showing the other end of a link). */
export function useNotesById(ids: string[]): Map<string, NoteHit> {
  const v = useNotesVersion();
  const key = useMemo(() => [...new Set(ids)].sort().join(","), [ids]);
  const [map, setMap] = useState<Map<string, NoteHit>>(new Map());
  useEffect(() => {
    let alive = true;
    const list = key ? key.split(",") : [];
    notesStore.byIds(list).then((hits) => alive && setMap(new Map(hits.map((h) => [h.note.id, h]))));
    return () => {
      alive = false;
    };
  }, [key, v]);
  return map;
}
