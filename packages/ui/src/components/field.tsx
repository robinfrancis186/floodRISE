import * as React from "react";
import { cn } from "../lib/utils";

export function FieldGroup(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-5", props.className)} {...props} />;
}

export function Field({ orientation = "vertical", ...props }: React.HTMLAttributes<HTMLDivElement> & { orientation?: "vertical" | "horizontal" }) {
  return <div className={cn("flex gap-2 data-[invalid]:text-destructive", orientation === "vertical" ? "flex-col" : "items-center", props.className)} {...props} />;
}

export function FieldLabel(props: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-sm font-semibold text-foreground", props.className)} {...props} />;
}

export function FieldDescription(props: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-xs leading-5 text-muted-foreground", props.className)} {...props} />;
}

export function FieldSet(props: React.FieldsetHTMLAttributes<HTMLFieldSetElement>) {
  return <fieldset className={cn("flex min-w-0 flex-col gap-3", props.className)} {...props} />;
}

export function FieldLegend(props: React.HTMLAttributes<HTMLLegendElement>) {
  return <legend className={cn("mb-1 text-sm font-semibold text-foreground", props.className)} {...props} />;
}
