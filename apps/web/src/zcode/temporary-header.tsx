import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, TimerIcon, Trash2Icon } from "lucide-react";
import { useState, type MouseEvent as ReactMouseEvent } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { WorkspaceBreadcrumbText } from "../components/WorkspaceBreadcrumb";
import { readLocalApi } from "../localApi";
import { textDirection } from "../textDirection";
import { useIsTemporaryThread } from "./temporary-conversation-store";
import { keepConversationPermanent, markConversationTemporary } from "./thread-actions";

/** The conversation a header shows: the keys its marker can live on, and how to destroy it. */
export interface ZcodeTemporaryConversation {
  readonly keys: ReadonlyArray<string>;
  readonly destroy: () => Promise<boolean>;
}

export const useZcodeTemporaryHeader = (input: {
  readonly conversation: ZcodeTemporaryConversation | undefined;
  readonly activeThreadRef: ScopedThreadRef;
  readonly onOpenProjectSettings: (() => void) | undefined;
}) => {
  const markerKeys = input.conversation?.keys ?? [scopedThreadKey(input.activeThreadRef)];
  const isTemporary = useIsTemporaryThread(markerKeys);
  const onOpenProjectSettings = input.onOpenProjectSettings;
  const openDraftMenuAt = (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    void api.contextMenu
      .show(
        [
          {
            id: isTemporary ? "keep-permanent" : "make-temporary",
            label: isTemporary ? "Keep permanently" : "Make temporary",
            icon: isTemporary ? "circle-check" : "timer",
          },
          ...(onOpenProjectSettings === undefined
            ? []
            : [{ id: "project-settings", label: "Project settings", icon: "settings" }]),
        ],
        position,
      )
      .then((action) => {
        if (action === "make-temporary") markConversationTemporary(markerKeys);
        else if (action === "keep-permanent") keepConversationPermanent(markerKeys);
        else if (action === "project-settings") onOpenProjectSettings?.();
      });
  };
  return {
    isTemporary,
    markerKeys,
    destroy: input.conversation?.destroy,
    /** The draft header's context menu; drafts have no server thread menu. */
    openDraftMenu: (event: ReactMouseEvent) => {
      event.preventDefault();
      openDraftMenuAt({ x: event.clientX, y: event.clientY });
    },
    openDraftMenuAt,
  };
};

type ZcodeTemporaryHeader = ReturnType<typeof useZcodeTemporaryHeader>;

export const ZcodeTemporaryBadge = (props: { readonly header: ZcodeTemporaryHeader }) =>
  props.header.isTemporary ? (
    <span
      aria-label="Temporary conversation"
      data-testid="temporary-conversation-indicator"
      className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground"
    >
      Temporary
    </span>
  ) : null;

export const ZcodeDraftConversationTitle = (props: {
  readonly title: string;
  readonly header: ZcodeTemporaryHeader;
}) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <button
          type="button"
          aria-label={`Draft conversation actions for ${props.title}`}
          aria-haspopup="menu"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            props.header.openDraftMenuAt({ x: rect.left, y: rect.bottom + 4 });
          }}
          className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
      }
    >
      <h2 className="flex min-w-0 items-center gap-2" dir={textDirection(props.title)}>
        <WorkspaceBreadcrumbText>{props.title}</WorkspaceBreadcrumbText>
        <ZcodeTemporaryBadge header={props.header} />
      </h2>
      <ChevronDownIcon
        aria-hidden
        data-thread-title-chevron
        className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
      />
    </TooltipTrigger>
    <TooltipPopup side="top">{props.title}</TooltipPopup>
  </Tooltip>
);

const DestroyTemporaryDialog = (props: {
  readonly open: boolean;
  readonly onResolve: (confirmed: boolean) => void;
}) => (
  <AlertDialog
    open={props.open}
    onOpenChange={(open) => {
      if (!open) props.onResolve(false);
    }}
  >
    <AlertDialogPopup>
      <AlertDialogHeader>
        <AlertDialogTitle>Destroy this temporary conversation?</AlertDialogTitle>
        <AlertDialogDescription className="whitespace-pre-line">
          T3 will remove it from your history and run available cleanup for linked resources.
          Database history and provider-side data may remain.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="outline" />}>Keep conversation</AlertDialogClose>
        <Button variant="destructive" onClick={() => props.onResolve(true)}>
          Destroy conversation
        </Button>
      </AlertDialogFooter>
    </AlertDialogPopup>
  </AlertDialog>
);

export const ZcodeTemporaryHeaderActions = (props: {
  readonly header: ZcodeTemporaryHeader;
  readonly canOperateThread: boolean;
}) => {
  const [confirming, setConfirming] = useState(false);
  const { header } = props;
  const resolveDestroy = async (confirmed: boolean) => {
    setConfirming(false);
    if (!confirmed) return;
    const destroyed = await header.destroy?.();
    if (destroyed) {
      toastManager.add({ type: "success", title: "Temporary conversation destroyed" });
    }
  };
  if (!header.isTemporary) {
    return (
      <Button
        variant="outline"
        size="xs"
        aria-label="Make conversation temporary"
        onClick={() => markConversationTemporary(header.markerKeys)}
      >
        <TimerIcon />
        Make temporary
      </Button>
    );
  }
  return (
    <>
      <Button
        variant="destructive"
        size="xs"
        aria-label="Destroy temporary conversation"
        disabled={!props.canOperateThread || header.destroy === undefined}
        onClick={() => setConfirming(true)}
      >
        <Trash2Icon />
        Destroy temporary
      </Button>
      <DestroyTemporaryDialog
        open={confirming}
        onResolve={(confirmed) => void resolveDestroy(confirmed)}
      />
    </>
  );
};
