import { Badge } from "@floodrise/ui";
import { Check, Info, TriangleAlert, UsersRound } from "lucide-react";

type Status = "COMMUNITY" | "PREDICTED" | "OPEN" | "OFFICIAL" | "SYSTEM";

export function StatusMark({ status }: { status: Status }) {
  if (status === "COMMUNITY") return <Badge variant="warning"><UsersRound aria-hidden />Community-corroborated</Badge>;
  if (status === "PREDICTED") return <Badge variant="default"><TriangleAlert aria-hidden />Rapid estimate</Badge>;
  if (status === "OPEN") return <Badge variant="success"><Check aria-hidden />Reported open</Badge>;
  if (status === "OFFICIAL") return <Badge variant="destructive"><TriangleAlert aria-hidden />Official demo alert</Badge>;
  return <Badge variant="secondary"><Info aria-hidden />System update</Badge>;
}
