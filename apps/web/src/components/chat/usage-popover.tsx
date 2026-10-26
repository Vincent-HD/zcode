import type { ReactNode } from "react";
import { Popover, PopoverTrigger, PopoverPopup, PopoverTitle } from "../ui/popover";

export const UsageRow = (props: { readonly label: string; readonly value: ReactNode }) => (
  <div className="flex items-center justify-between gap-6 py-1">
    <dt className="text-muted-foreground">{props.label}</dt>
    <dd className="text-right tabular-nums">{props.value}</dd>
  </div>
);

export const UsagePopover = (props: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly summary: ReactNode;
  readonly children: ReactNode;
}) => (
  <Popover>
    <PopoverTrigger
      render={
        <button
          type="button"
          aria-label={props.label}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-1 text-left transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        />
      }
    >
      {props.icon}
      <span className="truncate">{props.summary}</span>
    </PopoverTrigger>
    <PopoverPopup side="top" width="md" padding="compact">
      <div className="text-xs">
        <div className="mb-2 flex items-center gap-2 border-b border-border/60 pb-2 text-foreground">
          {props.icon}
          <PopoverTitle>{props.label}</PopoverTitle>
        </div>
        {props.children}
      </div>
    </PopoverPopup>
  </Popover>
);
