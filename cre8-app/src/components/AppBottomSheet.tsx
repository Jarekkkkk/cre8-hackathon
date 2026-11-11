import { useRef, type ReactNode, type Ref } from 'react';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import { AppIcon } from './AppIcon';

export function AppBottomSheet({
  open, onOpenChange, title, description, children, locked = false, titleRef, id, hideTitle = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  hideTitle?: boolean;
  description?: string;
  id?: string;
  children: ReactNode;
  locked?: boolean;
  titleRef?: Ref<HTMLHeadingElement>;
}) {
  const trigger = useRef<HTMLElement | null>(null);
  return (
    <Sheet open={open} onOpenChange={(next) => { if (next || !locked) onOpenChange(next); }}>
      <SheetContent
        side="bottom"
        id={id}
        className="app-bottom-sheet"
        showCloseButton={false}
        {...(!description && { "aria-describedby": undefined })}
        onOpenAutoFocus={(event) => {
          trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          event.preventDefault();
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (!trigger.current?.isConnected) return;
          event.preventDefault();
          trigger.current.focus();
        }}
      >
        <SheetHeader className={hideTitle ? "app-sheet-heading-hidden" : undefined}>
          <SheetTitle className={hideTitle ? "sr-only" : undefined} tabIndex={-1} ref={titleRef}>
            {title}
          </SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
          <AppSheetClose disabled={locked} />
        </SheetHeader>
        <div className="app-sheet-body">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

export function AppSheetClose({ disabled = false }: { disabled?: boolean }) {
  return (
    <SheetClose className="app-sheet-close" aria-label="Close" disabled={disabled}>
      <AppIcon name="close" size={19} />
    </SheetClose>
  );
}
