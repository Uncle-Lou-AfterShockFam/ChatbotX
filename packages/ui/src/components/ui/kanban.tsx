"use client";

import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  type UniqueIdentifier,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as React from "react";

import { cn } from "@chatbotx.io/ui/lib/utils";

/**
 * A board of droppable columns holding sortable cards. `Sortable` (single
 * container) is the sibling primitive; this one is the multi-container case.
 *
 * `onMove` fires once per drop with the card, the origin and destination
 * columns and the neighbours the card landed between (ids inside the
 * destination column, either may be null at an edge). The caller owns state:
 * the board re-renders from the props it is given, so an optimistic caller
 * updates its data on `onMove` and reverts on failure.
 */
export type KanbanMove = {
  cardId: UniqueIdentifier;
  fromColumnId: UniqueIdentifier;
  toColumnId: UniqueIdentifier;
  beforeId: UniqueIdentifier | null;
  afterId: UniqueIdentifier | null;
  /** Index of the card inside the destination column after the drop. */
  index: number;
};

type ColumnItems = Record<string, UniqueIdentifier[]>;

type KanbanContextValue = {
  columns: ColumnItems;
  activeId: UniqueIdentifier | null;
};

const KanbanContext = React.createContext<KanbanContextValue | null>(null);

function useKanbanContext(consumer: string) {
  const context = React.useContext(KanbanContext);
  if (!context) {
    throw new Error(`\`${consumer}\` must be used within \`Kanban\``);
  }
  return context;
}

function findColumnOf(
  columns: ColumnItems,
  id: UniqueIdentifier,
): string | null {
  if (id in columns) {
    return String(id);
  }
  for (const [columnId, items] of Object.entries(columns)) {
    if (items.includes(id)) {
      return columnId;
    }
  }
  return null;
}

export type KanbanProps = {
  /** Column id -> ordered card ids. Every column must be present, even when empty. */
  columns: ColumnItems;
  onMove: (move: KanbanMove) => void;
  /** Rendered in the drag overlay while a card is lifted. */
  renderOverlay?: (activeId: UniqueIdentifier) => React.ReactNode;
  children: React.ReactNode;
  className?: string;
};

function Kanban({
  columns,
  onMove,
  renderOverlay,
  children,
  className,
}: KanbanProps) {
  const [activeId, setActiveId] = React.useState<UniqueIdentifier | null>(
    null,
  );
  // The over-column changes while hovering; the drop reads the last hover so a
  // card released over an empty column (no card to be "over") still lands.
  const overColumnRef = React.useRef<string | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 150, tolerance: 6 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id);
    overColumnRef.current = null;
  }, []);

  const handleDragOver = React.useCallback(
    (event: DragOverEvent) => {
      if (event.over) {
        overColumnRef.current = findColumnOf(columns, event.over.id);
      }
    },
    [columns],
  );

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveId(null);
      const fromColumnId = findColumnOf(columns, active.id);
      const toColumnId = over
        ? findColumnOf(columns, over.id)
        : overColumnRef.current;
      overColumnRef.current = null;
      if (!(fromColumnId && toColumnId)) {
        return;
      }
      const target = columns[toColumnId].filter((id) => id !== active.id);
      let index = target.length;
      if (over && over.id !== toColumnId) {
        const overIndex = target.indexOf(over.id);
        if (overIndex !== -1) {
          // Dropping on a card: land after it when coming from above, before
          // it when coming from below or from another column.
          const fromIndex = columns[fromColumnId].indexOf(active.id);
          const sameColumn = fromColumnId === toColumnId;
          index = sameColumn && fromIndex < overIndex ? overIndex + 1 : overIndex;
        }
      }
      if (fromColumnId === toColumnId) {
        const fromIndex = columns[fromColumnId].indexOf(active.id);
        if (fromIndex === index) {
          return;
        }
      }
      onMove({
        cardId: active.id,
        fromColumnId,
        toColumnId,
        beforeId: index > 0 ? (target[index - 1] ?? null) : null,
        afterId: index < target.length ? (target[index] ?? null) : null,
        index,
      });
    },
    [columns, onMove],
  );

  const handleDragCancel = React.useCallback(() => {
    setActiveId(null);
    overColumnRef.current = null;
  }, []);

  const contextValue = React.useMemo(
    () => ({ columns, activeId }),
    [columns, activeId],
  );

  return (
    <KanbanContext.Provider value={contextValue}>
      <DndContext
        collisionDetection={closestCorners}
        onDragCancel={handleDragCancel}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragStart={handleDragStart}
        sensors={sensors}
      >
        <div
          className={cn("flex h-full gap-4 overflow-x-auto pb-4", className)}
          data-slot="kanban"
        >
          {children}
        </div>
        <DragOverlay>
          {activeId !== null && renderOverlay ? renderOverlay(activeId) : null}
        </DragOverlay>
      </DndContext>
    </KanbanContext.Provider>
  );
}

export type KanbanColumnProps = {
  id: UniqueIdentifier;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
};

function KanbanColumn({
  id,
  header,
  footer,
  children,
  className,
}: KanbanColumnProps) {
  const { columns } = useKanbanContext("KanbanColumn");
  const { setNodeRef, isOver } = useDroppable({ id });
  const items = columns[String(id)] ?? [];
  return (
    <div
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-lg border bg-muted/40",
        isOver && "ring-2 ring-primary/40",
        className,
      )}
      data-slot="kanban-column"
    >
      {header ? (
        <div className="border-b px-3 py-2" data-slot="kanban-column-header">
          {header}
        </div>
      ) : null}
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <div
          className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-2"
          data-slot="kanban-column-body"
          ref={setNodeRef}
        >
          {children}
        </div>
      </SortableContext>
      {footer ? (
        <div className="border-t px-3 py-2" data-slot="kanban-column-footer">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

export type KanbanCardProps = React.ComponentProps<"div"> & {
  id: UniqueIdentifier;
  disabled?: boolean;
};

function KanbanCard({
  id,
  disabled,
  className,
  children,
  style,
  ...props
}: KanbanCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  return (
    <div
      className={cn(
        "rounded-md border bg-background p-3 text-sm shadow-xs",
        !disabled && "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-40",
        className,
      )}
      data-dragging={isDragging ? "" : undefined}
      data-slot="kanban-card"
      ref={setNodeRef}
      style={{
        ...style,
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      {...attributes}
      {...listeners}
      {...props}
    >
      {children}
    </div>
  );
}

/** A static clone shown under the pointer while a card is lifted. */
function KanbanOverlay({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "w-72 cursor-grabbing rounded-md border bg-background p-3 text-sm shadow-lg",
        className,
      )}
      data-slot="kanban-overlay"
      {...props}
    >
      {children}
    </div>
  );
}

export { Kanban, KanbanCard, KanbanColumn, KanbanOverlay };
