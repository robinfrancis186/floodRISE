import { Badge } from "@floodrise/ui";
import { AlertCircle, CheckCircle2, Clock3, HelpCircle } from "lucide-react";
import type { ReactNode } from "react";

type Tone = "success" | "warning" | "danger" | "info" | "neutral";

export function StatusPill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  const variant = tone === "success" ? "success" : tone === "warning" ? "warning" : tone === "danger" ? "destructive" : tone === "info" ? "default" : "secondary";
  const Icon = tone === "success" ? CheckCircle2 : tone === "warning" || tone === "danger" ? AlertCircle : tone === "info" ? Clock3 : HelpCircle;
  return <Badge variant={variant}><Icon aria-hidden />{children}</Badge>;
}

export function Confidence({ value }: { value: number }) {
  return <StatusPill tone={value >= 80 ? "success" : value >= 65 ? "warning" : "danger"}>{value}% confidence</StatusPill>;
}
