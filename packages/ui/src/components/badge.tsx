import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

const badgeVariants = cva(
  "inline-flex min-h-6 items-center gap-1 rounded-[2px] border px-2 py-0.5 text-xs font-semibold tabular-nums [&_svg]:size-3.5",
  {
    variants: {
      variant: {
        default: "border-primary/20 bg-primary/8 text-primary",
        secondary: "border-border bg-muted text-muted-foreground",
        outline: "border-border bg-background text-foreground",
        success: "border-success/25 bg-success/8 text-success",
        warning: "border-warning/30 bg-warning/10 text-warning-foreground",
        destructive: "border-destructive/25 bg-destructive/8 text-destructive"
      }
    },
    defaultVariants: { variant: "default" }
  }
);

export function Badge({ className, variant, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
