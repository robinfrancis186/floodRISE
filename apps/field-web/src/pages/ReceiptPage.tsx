import { Link, useParams } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle, Badge, Button } from "@floodrise/ui";
import { CheckCircle2, Clock3, FileCheck2, LockKeyhole, MapPin, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { getReceipt, type ReportReceipt } from "../lib/db";
import { formatDateTime } from "../lib/format";

export function ReceiptPage() {
  const { receiptId } = useParams({ from: "/receipt/$receiptId" });
  const [receipt, setReceipt] = useState<ReportReceipt | null | undefined>(undefined);

  useEffect(() => {
    void getReceipt(receiptId).then((value) => setReceipt(value ?? null));
  }, [receiptId]);

  if (receipt === undefined) return <div className="page page-content loading-row" role="status">Opening report receipt…</div>;

  if (!receipt) {
    return (
      <div className="page page-content standard-page receipt-page">
        <Alert variant="warning">
          <AlertTitle>Receipt not available on this device</AlertTitle>
          <AlertDescription>It may have been submitted from another device or removed with site data.</AlertDescription>
        </Alert>
        <Button asChild><Link to="/">Return to conditions</Link></Button>
      </div>
    );
  }

  return (
    <div className="page page-content standard-page receipt-page">
      <div className="receipt-success-mark"><CheckCircle2 aria-hidden /></div>
      <div className="receipt-heading">
        <Badge variant={receipt.source === "DEMO" ? "warning" : "success"}>{receipt.source === "DEMO" ? "Demo receipt" : "Received"}</Badge>
        <h1>Report received</h1>
        <p>{receipt.message}</p>
      </div>

      <dl className="receipt-details">
        <div><dt><FileCheck2 aria-hidden />Reference</dt><dd>{receipt.reference}</dd></div>
        <div><dt><MapPin aria-hidden />Location</dt><dd>{receipt.placeLabel}</dd></div>
        <div><dt><Clock3 aria-hidden />Received</dt><dd>{formatDateTime(receipt.receivedAt)}</dd></div>
        <div><dt><UsersRound aria-hidden />Status</dt><dd>Awaiting independence and consistency checks</dd></div>
      </dl>

      <Alert variant="info">
        <LockKeyhole aria-hidden className="alert-leading-icon" />
        <div>
          <AlertTitle>Public identity protected</AlertTitle>
          <AlertDescription>Public views use aggregated evidence and do not expose your report identity.</AlertDescription>
        </div>
      </Alert>

      <div className="receipt-actions">
        <Button asChild size="lg"><Link to="/">View current conditions</Link></Button>
        <Button asChild size="lg" variant="outline"><Link to="/report">Submit another report</Link></Button>
      </div>

      <p className="page-footnote">Expiry or resolution never means an area is safe. Follow authorized emergency instructions.</p>
    </div>
  );
}
