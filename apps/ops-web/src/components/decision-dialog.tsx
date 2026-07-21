import { Button, Field, FieldDescription, FieldLabel, Textarea } from "@floodrise/ui";
import { X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

export function DecisionDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  requireNote = false,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  requireNote?: boolean;
  onClose: () => void;
  onConfirm: (note: string) => boolean | void | Promise<boolean | void>;
}) {
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const titleId = useId();
  const noteId = useId();

  useEffect(() => {
    if (open) {
      setNote("");
      setSubmitting(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const appFrame = document.querySelector<HTMLElement>(".app-frame");
    const previousAriaHidden = appFrame?.getAttribute("aria-hidden") ?? null;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    appFrame?.setAttribute("inert", "");
    appFrame?.setAttribute("aria-hidden", "true");
    return () => {
      appFrame?.removeAttribute("inert");
      if (previousAriaHidden === null) appFrame?.removeAttribute("aria-hidden");
      else appFrame?.setAttribute("aria-hidden", previousAriaHidden);
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) return null;
  const invalid = requireNote && !note.trim();
  const confirm = async () => {
    setSubmitting(true);
    try {
      const completed = await onConfirm(note);
      if (completed !== false) onClose();
    } finally {
      setSubmitting(false);
    }
  };
  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-heading">
          <div>
            <h2 id={titleId}>{title}</h2>
            <p>{description}</p>
          </div>
          <Button autoFocus variant="ghost" size="icon" aria-label="Close decision dialog" onClick={onClose}><X /></Button>
        </div>
        <Field>
          <FieldLabel htmlFor={noteId}>Decision note {requireNote ? "(required)" : "(optional)"}</FieldLabel>
          <Textarea id={noteId} maxLength={250} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add context for the audit trail…" />
          <FieldDescription>{note.length}/250 · The decision and bound evidence/model versions will be recorded.</FieldDescription>
        </Field>
        <div className="dialog-actions">
          <Button variant="outline" disabled={submitting} onClick={onClose}>Cancel</Button>
          <Button variant={destructive ? "destructive" : "default"} disabled={invalid || submitting} onClick={() => void confirm()}>{submitting ? "Recording…" : confirmLabel}</Button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
