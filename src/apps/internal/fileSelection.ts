export interface FileSelection {
  entryIds: Set<string>;
  anchorEntryId?: string;
}

export function updateFileSelection(
  orderedEntryIds: readonly string[],
  current: FileSelection,
  clickedEntryId: string,
  modifiers: {
    toggle: boolean;
    range: boolean;
  },
): FileSelection {
  if (!orderedEntryIds.includes(clickedEntryId)) return current;
  if (modifiers.range && current.anchorEntryId) {
    const anchorIndex = orderedEntryIds.indexOf(current.anchorEntryId);
    const clickedIndex = orderedEntryIds.indexOf(clickedEntryId);
    if (anchorIndex >= 0) {
      const start = Math.min(anchorIndex, clickedIndex);
      const end = Math.max(anchorIndex, clickedIndex);
      const range = orderedEntryIds.slice(start, end + 1);
      return {
        entryIds: modifiers.toggle
          ? new Set([...current.entryIds, ...range])
          : new Set(range),
        anchorEntryId: current.anchorEntryId,
      };
    }
  }
  if (modifiers.toggle) {
    const entryIds = new Set(current.entryIds);
    if (entryIds.has(clickedEntryId)) entryIds.delete(clickedEntryId);
    else entryIds.add(clickedEntryId);
    return { entryIds, anchorEntryId: clickedEntryId };
  }
  return {
    entryIds: new Set([clickedEntryId]),
    anchorEntryId: clickedEntryId,
  };
}

