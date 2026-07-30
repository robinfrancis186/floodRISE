import * as React from "react";
import { cn } from "../lib/utils";

type TableProps = React.TableHTMLAttributes<HTMLTableElement> & {
  scrollLabel: string;
};

export function Table({ className, scrollLabel, ...props }: TableProps) {
  return <div className="relative w-full overflow-auto" role="region" aria-label={scrollLabel} tabIndex={0}><table className={cn("w-full caption-bottom text-sm", className)} {...props} /></div>;
}
export function TableHeader(props: React.HTMLAttributes<HTMLTableSectionElement>) { return <thead className={cn("border-b border-border bg-muted/55", props.className)} {...props} />; }
export function TableBody(props: React.HTMLAttributes<HTMLTableSectionElement>) { return <tbody className={cn("divide-y divide-border", props.className)} {...props} />; }
export function TableRow(props: React.HTMLAttributes<HTMLTableRowElement>) { return <tr className={cn("transition-colors hover:bg-muted/55 data-[state=selected]:bg-flood/6", props.className)} {...props} />; }
export function TableHead(props: React.ThHTMLAttributes<HTMLTableCellElement>) { return <th className={cn("h-10 px-3 text-left align-middle text-xs font-semibold uppercase tracking-wide text-muted-foreground", props.className)} {...props} />; }
export function TableCell(props: React.TdHTMLAttributes<HTMLTableCellElement>) { return <td className={cn("px-3 py-2.5 align-middle tabular-nums", props.className)} {...props} />; }
