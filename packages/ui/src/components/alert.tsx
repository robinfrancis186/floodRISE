import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

const alertVariants = cva("relative grid gap-1 rounded-[3px] border p-3 text-sm", {
  variants: {
    variant: {
      default: "border-border bg-background text-foreground",
      warning: "border-warning/35 bg-warning/6 text-foreground",
      destructive: "border-destructive/30 bg-destructive/5 text-foreground",
      info: "border-flood/30 bg-flood/5 text-foreground"
    }
  },
  defaultVariants: { variant: "default" }
});

export function Alert({ className, variant, ...props }: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

export function AlertTitle(props: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("font-semibold leading-none", props.className)} {...props} />;
}

export function AlertDescription(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-sm text-muted-foreground", props.className)} {...props} />;
}
