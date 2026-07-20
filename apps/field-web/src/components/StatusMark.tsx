import { Badge } from "@floodrise/ui";
import { Check, Info, TriangleAlert, UsersRound } from "lucide-react";

type Status = "COMMUNITY" | "PREDICTED" | "OPEN" | "OFFICIAL" | "SYSTEM";

export function StatusMark({ status }: { status: Status }) {
  if (status === "COMMUNITY") {
    return <Badge className="condition-status" data-status="community" variant="warning"><UsersRound aria-hidden />Community-corroborated</Badge>;
  }
  if (status === "PREDICTED") {
    return <Badge className="condition-status" data-status="estimate" variant="default"><TriangleAlert aria-hidden />Rapid estimate</Badge>;
  }
  if (status === "OPEN") {
    return <Badge className="condition-status" data-status="open" variant="success"><Check aria-hidden />Reported open</Badge>;
  }
  if (status === "OFFICIAL") {
    return <Badge className="condition-status" data-status="official" variant="destructive"><TriangleAlert aria-hidden />Official demo alert</Badge>;
  }
  return <Badge className="condition-status" data-status="system" variant="secondary"><Info aria-hidden />System update</Badge>;
}
