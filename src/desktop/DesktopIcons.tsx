import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useDesktopStore } from "../store/desktopStore";
import { ContextMenu } from "../components/ContextMenu";
import { EntryIdenticon } from "../components/EntryIdenticon";
import { useDesktopSurfaceStore } from "../desktopSurface/store";
import type {
  DesktopItem,
} from "../desktopSurface/types";
import { activateDesktopItem } from "../desktopSurface/activate";
import {
  DESKTOP_ITEM_HEIGHT,
  DESKTOP_ITEM_WIDTH,
  findGroupPlacement,
} from "../desktopSurface/layout";
const DRAG_THRESHOLD = 4;

interface Point {
  x: number;
  y: number;
}

interface PendingPointer {
  pointerId: number;
  origin: Point;
  current: Point;
  mode: "marquee" | "drag";
  itemId?: string;
  baseline: Set<string>;
  selectionMode: "replace" | "toggle" | "add";
  active: boolean;
}

interface ItemContextMenu {
  itemId: string;
  x: number;
  y: number;
  error?: string;
  working: boolean;
}

export function DesktopIcons() {
  const surface = useDesktopSurfaceStore((state) => state.surface);
  const status = useDesktopSurfaceStore((state) => state.status);
  const error = useDesktopSurfaceStore((state) => state.error);
  const selectedItemIds = useDesktopSurfaceStore(
    (state) => state.selectedItemIds,
  );
  const setSelection = useDesktopSurfaceStore(
    (state) => state.setSelection,
  );
  const toggleSelection = useDesktopSurfaceStore(
    (state) => state.toggleSelection,
  );
  const clearSelection = useDesktopSurfaceStore(
    (state) => state.clearSelection,
  );
  const moveItems = useDesktopSurfaceStore((state) => state.move);
  const closeAppMenu = useDesktopStore((state) => state.closeAppMenu);
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<PendingPointer | undefined>(undefined);
  const suppressClickRef = useRef(false);
  const [marquee, setMarquee] = useState<{
    origin: Point;
    current: Point;
  }>();
  const [dragPreview, setDragPreview] = useState<Point>();
  const [dragItemIds, setDragItemIds] = useState<Set<string>>();
  const [contextMenu, setContextMenu] = useState<ItemContextMenu>();

  useEffect(() => {
    const cancel = () => {
      pendingRef.current = undefined;
      setMarquee(undefined);
      setDragPreview(undefined);
      setDragItemIds(undefined);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cancel();
        clearSelection();
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "a" &&
        document.activeElement?.closest(".desktop-icon-layer")
      ) {
        event.preventDefault();
        setSelection(surface.items.map((item) => item.id));
      } else if (
        event.key === "Delete" &&
        selectedItemIds.size > 0 &&
        document.activeElement?.closest(".desktop-icon-layer")
      ) {
        void useDesktopSurfaceStore
          .getState()
          .remove([...selectedItemIds])
          .catch(() => undefined);
      }
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    clearSelection,
    selectedItemIds,
    setSelection,
    surface.items,
  ]);

  const activate = (item: DesktopItem) => {
    if (!item.resolved.available || suppressClickRef.current) return;
    closeAppMenu();
    void activateDesktopItem(item).catch((reason: unknown) => {
      window.alert(
        reason instanceof Error ? reason.message : "无法打开桌面项目",
      );
    });
  };

  const beginMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      (event.target instanceof Element &&
        event.target.closest(
          "[data-desktop-item-id], .context-menu, .desktop-icons__status",
        ))
    ) {
      return;
    }
    const origin = localPoint(event, event.currentTarget);
    pendingRef.current = {
      pointerId: event.pointerId,
      origin,
      current: origin,
      mode: "marquee",
      baseline: new Set(selectedItemIds),
      selectionMode:
        event.ctrlKey || event.metaKey
          ? "toggle"
          : event.shiftKey
            ? "add"
            : "replace",
      active: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    closeAppMenu();
  };

  const beginDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    itemId: string,
  ) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const selected = selectedItemIds.has(itemId)
      ? new Set(selectedItemIds)
      : new Set([itemId]);
    if (!selectedItemIds.has(itemId) && !event.ctrlKey && !event.metaKey) {
      setSelection(selected);
    }
    pendingRef.current = {
      pointerId: event.pointerId,
      origin: { x: event.clientX, y: event.clientY },
      current: { x: event.clientX, y: event.clientY },
      mode: "drag",
      itemId,
      baseline: selected,
      selectionMode: "replace",
      active: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const pending = pendingRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    const current =
      pending.mode === "marquee"
        ? localPoint(event, event.currentTarget)
        : { x: event.clientX, y: event.clientY };
    pending.current = current;
    if (
      !pending.active &&
      distance(pending.origin, current) >= DRAG_THRESHOLD
    ) {
      pending.active = true;
      suppressClickRef.current = true;
    }
    if (!pending.active) return;
    if (pending.mode === "marquee") {
      setMarquee({ origin: pending.origin, current });
      updateMarqueeSelection(
        event.currentTarget,
        pending,
        setSelection,
      );
    } else {
      setDragItemIds(pending.baseline);
      setDragPreview({
        x: current.x - pending.origin.x,
        y: current.y - pending.origin.y,
      });
    }
  };

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pending = pendingRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    pendingRef.current = undefined;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (pending.mode === "marquee") {
      if (!pending.active && pending.selectionMode === "replace") {
        clearSelection();
      }
      setMarquee(undefined);
    } else if (pending.active && dragPreview) {
      const xDelta = Math.round(dragPreview.x);
      const yDelta = Math.round(dragPreview.y);
      if (xDelta !== 0 || yDelta !== 0) {
        const moves = findGroupPlacement(
          surface.items,
          pending.baseline,
          xDelta,
          yDelta,
          {
            maxX: Math.max(
              0,
              event.currentTarget.clientWidth -
                DESKTOP_ITEM_WIDTH -
                20,
            ),
            maxY: Math.max(
              0,
              event.currentTarget.clientHeight -
                DESKTOP_ITEM_HEIGHT -
                28,
            ),
          },
        );
        if (moves) void moveItems(moves).catch(() => undefined);
      }
      setDragPreview(undefined);
      setDragItemIds(undefined);
    }
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  return (
    <div
      ref={containerRef}
      className="desktop-icons"
      role="group"
      aria-label="桌面项目"
      data-status={status}
      onPointerDown={beginMarquee}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
    >
      {surface.items.map((item) => {
        const selected = selectedItemIds.has(item.id);
        const previewing = dragPreview && dragItemIds?.has(item.id);
        return (
          <button
            className="desktop-icon"
            data-desktop-item-id={item.id}
            data-selected={selected}
            data-available={item.resolved.available}
            key={item.id}
            type="button"
            aria-selected={selected}
            title={
              item.resolved.available
                ? item.resolved.name
                : item.resolved.reason
            }
            style={{
              transform: `translate(${
                item.position.x + (previewing ? dragPreview.x : 0)
              }px, ${
                item.position.y + (previewing ? dragPreview.y : 0)
              }px)`,
            }}
            onPointerDown={(event) => beginDrag(event, item.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setContextMenu({
                itemId: item.id,
                x: event.clientX,
                y: event.clientY,
                working: false,
              });
            }}
            onClick={(event) => {
              event.stopPropagation();
              if (suppressClickRef.current) return;
              if (event.ctrlKey || event.metaKey) {
                toggleSelection(item.id);
              } else if (event.shiftKey) {
                setSelection([...selectedItemIds, item.id]);
              } else {
                setSelection([item.id]);
              }
            }}
            onDoubleClick={() => activate(item)}
            onKeyDown={(event) => {
              if (event.key === "Enter") activate(item);
              if (event.key === " ") {
                event.preventDefault();
                toggleSelection(item.id);
              }
              if (
                ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
                  event.key,
                )
              ) {
                event.preventDefault();
                focusGridNeighbor(
                  event.currentTarget,
                  item,
                  surface.items,
                  event.key,
                );
              }
              if (
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              ) {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                setContextMenu({
                  itemId: item.id,
                  x: rect.left + 20,
                  y: rect.top + 20,
                  working: false,
                });
              }
            }}
          >
            <DesktopTargetIcon item={item} />
            <span className="desktop-icon__label">
              {item.resolved.name}
            </span>
          </button>
        );
      })}
      {marquee && <MarqueeBox {...marquee} />}
      {dragPreview && dragItemIds?.size ? (
        <span className="desktop-drag-count" aria-hidden="true">
          {dragItemIds.size}
        </span>
      ) : null}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(undefined)}
        >
          <button
            type="button"
            role="menuitem"
            disabled={contextMenu.working}
            onClick={() => {
              setContextMenu((current) =>
                current
                  ? { ...current, working: true, error: undefined }
                  : current,
              );
              void useDesktopSurfaceStore
                .getState()
                .remove([contextMenu.itemId])
                .then(() => setContextMenu(undefined))
                .catch((reason: unknown) =>
                  setContextMenu((current) =>
                    current
                      ? {
                          ...current,
                          working: false,
                          error:
                            reason instanceof Error
                              ? reason.message
                              : "无法从桌面移除项目",
                        }
                      : current,
                  ),
                );
            }}
          >
            从桌面移除
          </button>
          {contextMenu.error && (
            <p className="context-menu__error" role="alert">
              {contextMenu.error}
            </p>
          )}
        </ContextMenu>
      )}
      {status === "loading" && (
        <span className="desktop-icons__status">
          正在加载桌面项目…
        </span>
      )}
      {status === "error" && (
        <button
          className="desktop-icons__status desktop-icons__status--error"
          type="button"
          onClick={() => void useDesktopSurfaceStore.getState().load()}
        >
          {error ?? "桌面项目加载失败"}，点击重试
        </button>
      )}
      {status === "ready" && error && (
        <button
          className="desktop-icons__status desktop-icons__status--warning"
          type="button"
          onClick={() => void useDesktopSurfaceStore.getState().load()}
        >
          {error} 点击刷新桌面状态
        </button>
      )}
    </div>
  );
}

function MarqueeBox({ origin, current }: { origin: Point; current: Point }) {
  return (
    <div
      className="desktop-marquee"
      aria-hidden="true"
      style={{
        left: Math.min(origin.x, current.x),
        top: Math.min(origin.y, current.y),
        width: Math.abs(current.x - origin.x),
        height: Math.abs(current.y - origin.y),
      }}
    />
  );
}

function DesktopTargetIcon({ item }: { item: DesktopItem }) {
  if (item.resolved.icon) {
    return (
      <img
        className="app-icon"
        src={item.resolved.icon}
        alt=""
        draggable={false}
      />
    );
  }
  if (item.target.type === "file") {
    return (
      <EntryIdenticon
        entryId={item.target.handle}
        size={48}
        className="desktop-entry-identicon"
      />
    );
  }
  return (
    <span
      className="desktop-target-icon"
      data-kind={item.target.type}
      aria-hidden="true"
    >
      📁
    </span>
  );
}

function localPoint(
  event: ReactPointerEvent,
  element: HTMLElement,
): Point {
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function distance(left: Point, right: Point) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function updateMarqueeSelection(
  container: HTMLElement,
  pending: PendingPointer,
  setSelection: (ids: Iterable<string>) => void,
) {
  const containerRect = container.getBoundingClientRect();
  const selectionRect = {
    left: Math.min(pending.origin.x, pending.current.x) + containerRect.left,
    right: Math.max(pending.origin.x, pending.current.x) + containerRect.left,
    top: Math.min(pending.origin.y, pending.current.y) + containerRect.top,
    bottom: Math.max(pending.origin.y, pending.current.y) + containerRect.top,
  };
  const hits = new Set<string>();
  container
    .querySelectorAll<HTMLElement>("[data-desktop-item-id]")
    .forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (
        rect.left < selectionRect.right &&
        rect.right > selectionRect.left &&
        rect.top < selectionRect.bottom &&
        rect.bottom > selectionRect.top
      ) {
        const itemId = element.dataset.desktopItemId;
        if (itemId) hits.add(itemId);
      }
    });
  if (pending.selectionMode === "replace") {
    setSelection(hits);
  } else if (pending.selectionMode === "add") {
    setSelection([...pending.baseline, ...hits]);
  } else {
    const result = new Set(pending.baseline);
    hits.forEach((itemId) => {
      if (result.has(itemId)) result.delete(itemId);
      else result.add(itemId);
    });
    setSelection(result);
  }
}

function focusGridNeighbor(
  current: HTMLElement,
  item: DesktopItem,
  items: DesktopItem[],
  key: string,
) {
  const candidates = items
    .filter((candidate) => {
      if (candidate.id === item.id) return false;
      const xDelta = candidate.position.x - item.position.x;
      const yDelta = candidate.position.y - item.position.y;
      if (key === "ArrowLeft") return xDelta < 0;
      if (key === "ArrowRight") return xDelta > 0;
      if (key === "ArrowUp") return yDelta < 0;
      return yDelta > 0;
    })
    .sort((left, right) => {
      const leftDistance =
        Math.abs(left.position.x - item.position.x) +
        Math.abs(left.position.y - item.position.y);
      const rightDistance =
        Math.abs(right.position.x - item.position.x) +
        Math.abs(right.position.y - item.position.y);
      return leftDistance - rightDistance;
    });
  const targetId = candidates[0]?.id;
  if (!targetId) return;
  current
    .closest(".desktop-icons")
    ?.querySelector<HTMLElement>(
      `[data-desktop-item-id="${targetId}"]`,
    )
    ?.focus();
}
