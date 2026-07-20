import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cn } from "../lib/utils";

export const ToggleGroup = React.forwardRef<React.ElementRef<typeof ToggleGroupPrimitive.Root>, React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>>(
  ({ className, ...props }, ref) => <ToggleGroupPrimitive.Root ref={ref} className={cn("grid gap-2", className)} {...props} />
);
ToggleGroup.displayName = "ToggleGroup";

export const ToggleGroupItem = React.forwardRef<React.ElementRef<typeof ToggleGroupPrimitive.Item>, React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>>(
  ({ className, ...props }, ref) => (
    <ToggleGroupPrimitive.Item ref={ref} className={cn("min-h-11 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:border-flood data-[state=on]:bg-flood/6 data-[state=on]:text-link", className)} {...props} />
  )
);
ToggleGroupItem.displayName = "ToggleGroupItem";
