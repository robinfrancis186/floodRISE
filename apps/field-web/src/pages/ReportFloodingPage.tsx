import { zodResolver } from "@hookform/resolvers/zod";
import { FloodMap } from "@floodrise/map";
import { useNavigate } from "@tanstack/react-router";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  FieldDescription,
  FieldLegend,
  FieldSet,
  Textarea,
  ToggleGroup,
  ToggleGroupItem
} from "@floodrise/ui";
import {
  Ban,
  Camera,
  CarFront,
  Check,
  ChevronRight,
  CloudUpload,
  Construction,
  Footprints,
  Info,
  LocateFixed,
  LockKeyhole,
  PersonStanding,
  Power,
  RefreshCw,
  ShieldAlert,
  TreePine,
  Waves,
  X
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useNetworkStatus } from "../hooks/useNetworkStatus";
import { useQueueSummary } from "../hooks/useQueueSummary";
import { ReportSubmissionError, shouldRetrySubmission, submitReport } from "../lib/api";
import { useFieldCloudAccess } from "../lib/cloud-access";
import {
  enqueueReport,
  rememberReceiptForSession,
  saveReceipt,
  type OfflineReportDraft,
  type PhotoDraft
} from "../lib/db";
import { createClientReportId, getDeviceId, getReporterId } from "../lib/identity";
import { isLiveEligibleLocationAccuracy } from "../lib/location-policy";
import { defaultReportValues, reportFormSchema, type ReportFormValues } from "../lib/report-schema";

const depthOptions = [
  { value: "ANKLE", title: "Ankle", detail: "<0.15 m", icon: Footprints },
  { value: "KNEE", title: "Knee", detail: "0.15–0.5 m", icon: Footprints },
  { value: "WAIST", title: "Waist", detail: "0.5–1 m", icon: PersonStanding },
  { value: "ABOVE_WAIST", title: "Above waist", detail: ">1 m", icon: Waves }
] as const;

const roadOptions = [
  { value: "OPEN", title: "Open", icon: CarFront },
  { value: "DIFFICULT", title: "Difficult", icon: Waves },
  { value: "IMPASSABLE", title: "Impassable", icon: Ban }
] as const;

const issueOptions = [
  { value: "BLOCKED_DRAIN", title: "Blocked drain", icon: Construction },
  { value: "FALLEN_TREE", title: "Fallen tree", icon: TreePine },
  { value: "BRIDGE_DAMAGE", title: "Bridge damage", icon: Construction },
  { value: "POWER_HAZARD", title: "Power hazard", icon: Power }
] as const;

const supportedPhotoTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

type FieldLocation = {
  latitude: number;
  longitude: number;
  accuracy: number;
  label: string;
};

const demoLocation: FieldLocation = {
  latitude: 10.1041000,
  longitude: 76.3519000,
  accuracy: 12,
  label: "Aluva–Paravur Road"
};

export function ReportFloodingPage() {
  const navigate = useNavigate();
  const { isOnline } = useNetworkStatus();
  const { runtime } = useFieldCloudAccess();
  const isDemo = runtime.mode === "demo";
  const queue = useQueueSummary();
  const fileInputId = useId();
  const [location, setLocation] = useState<FieldLocation | null>(
    () => isDemo ? demoLocation : null,
  );
  const [locating, setLocating] = useState(false);
  const [photo, setPhoto] = useState<PhotoDraft | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedOffline, setSavedOffline] = useState(false);
  const locationIsLiveEligible = location
    ? isLiveEligibleLocationAccuracy(location.accuracy)
    : false;

  const {
    control,
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    watch
  } = useForm<ReportFormValues>({
    resolver: zodResolver(reportFormSchema),
    defaultValues: defaultReportValues
  });
  const note = watch("note");

  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  async function useCurrentLocation() {
    if (!navigator.geolocation) {
      setFormError("Location services are unavailable. You can still use the selected map pin.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          label: "Current location"
        });
        setLocating(false);
        setFormError(null);
      },
      () => {
        setFormError(
          isDemo
            ? "Location permission was not available. The Aluva demo pin is still selected."
            : "Location permission was not available. A verified device location is required for a live report.",
        );
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 8_000, maximumAge: 30_000 }
    );
  }

  async function onPhotoChange(file: File | undefined) {
    setFormError(null);
    if (!file) return;
    if (!supportedPhotoTypes.has(file.type)) {
      setFormError("Choose a JPEG, PNG, or WebP image for optional evidence.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setFormError("Photo must be 5 MB or smaller for reliable offline storage.");
      return;
    }
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    const nextPreview = URL.createObjectURL(file);
    previewRef.current = nextPreview;
    setPreviewUrl(nextPreview);
    const dataUrl = await fileToDataUrl(file);
    setPhoto({ name: file.name, type: file.type, dataUrl });
  }

  function removePhoto() {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreviewUrl(null);
    setPhoto(null);
  }

  async function submit(values: ReportFormValues) {
    setFormError(null);
    setSavedOffline(false);
    if (!runtime.incidentId || !runtime.referenceTime) {
      setFormError(
        "No verified authority incident is available. Reconnect and verify secure access before creating this report.",
      );
      return;
    }
    if (!location) {
      setFormError("Use the current device location before creating a live report.");
      return;
    }
    const clientId = createClientReportId();
    const draft: OfflineReportDraft = {
      client_report_id: clientId,
      incident_id: runtime.incidentId,
      reporter_id: getReporterId(),
      device_id: getDeviceId(),
      observed_at: isDemo ? runtime.referenceTime : new Date().toISOString(),
      location: {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy_m: location.accuracy
      },
      water_depth: values.waterDepth,
      road_status: values.roadStatus,
      infrastructure_issues: values.infrastructureIssues,
      note: values.note || undefined,
      place_label: location.label,
      photo: photo ?? undefined
    };

    if (!isOnline) {
      try {
        await enqueueReport(draft);
        setSavedOffline(true);
        await navigate({ to: "/queue" });
      } catch (error) {
        setFormError(error instanceof Error ? error.message : "Report could not be stored offline.");
      }
      return;
    }

    let receipt: Awaited<ReturnType<typeof submitReport>>;
    try {
      receipt = await submitReport(draft);
    } catch (error) {
      if (!shouldRetrySubmission(error)) {
        setFormError(error instanceof Error ? error.message : "Report could not be submitted.");
        return;
      }
      try {
        await enqueueReport(
          draft,
          Date.now(),
          error instanceof ReportSubmissionError
            ? {
                nextAttemptAt: Date.now() + Math.max(1_000, error.retryAfterMs),
                lastError: error.message
              }
            : undefined
        );
        setSavedOffline(true);
        await navigate({ to: "/queue" });
      } catch (queueError) {
        setFormError(queueError instanceof Error ? queueError.message : "Report could not be stored offline.");
      }
      return;
    }

    try {
      await saveReceipt(receipt);
    } catch {
      // The API has already accepted this immutable client ID. Preserve the
      // acknowledgement for this session and keep the exact encrypted draft
      // retryable so a later idempotent replay can repair durable receipt
      // storage without creating a second evidence record.
      rememberReceiptForSession(receipt);
      try {
        await enqueueReport(draft, Date.now(), {
          nextAttemptAt: Date.now() + 5_000,
          lastError: "Report accepted by the API; local receipt storage will retry."
        });
      } catch {
        // The authoritative report and in-memory receipt remain usable. The
        // receipt screen can also recover the minimal acknowledgement from the
        // authenticated report endpoint after a reload.
      }
    }
    await navigate({ to: "/receipt/$receiptId", params: { receiptId: receipt.id } });
  }

  return (
    <div className="page report-page">
      <section className="report-map" aria-label="Selected report location">
        {isDemo ? (
          <FloodMap
            variant="field"
            horizon="3h"
            height={470}
            showSummary={false}
            showLegend={false}
            showHorizonControl={false}
            interactive={false}
            visibleFeatureIds={["cluster-aluva"]}
            ariaLabel="Flood conditions around selected report pin"
          />
        ) : (
          <div className="route-map-paused field-live-map-boundary" role="status">
            <LocateFixed aria-hidden />
            <strong>Live report location</strong>
            <span>
              {location
                ? `Device location acquired with ±${Math.round(location.accuracy)} m accuracy.`
                : "Use the device location control below. No demo pin is selected."}
            </span>
          </div>
        )}
      </section>

      <section className="report-sheet" aria-labelledby="report-heading">
        <div className="sheet-handle" aria-hidden />
        <div className="report-title-row">
          <div>
            <h1 id="report-heading">Report flooding</h1>
            <p><LockKeyhole aria-hidden />Your identity is hidden from public views.</p>
          </div>
          <Button type="button" variant="ghost" size="icon" aria-label="Close report form" onClick={() => void navigate({ to: "/" })}>
            <X aria-hidden />
          </Button>
        </div>

        <form onSubmit={handleSubmit(submit)} className="report-form" noValidate>
          <div className="location-row">
            <span className="location-icon"><LocateFixed aria-hidden /></span>
            <div>
              <strong>{location?.label ?? "Device location required"}</strong>
              <span>
                {location
                  ? `±${Math.round(location.accuracy)} m accuracy`
                  : "No default location is used in live mode"}
              </span>
            </div>
            <Button type="button" variant="link" onClick={() => void useCurrentLocation()} disabled={locating}>
              {locating
                ? "Locating…"
                : isDemo
                  ? "Adjust pin"
                  : location
                    ? "Update location"
                    : "Use current"}
              <ChevronRight aria-hidden />
            </Button>
          </div>

          {location && !locationIsLiveEligible ? (
            <Alert variant="warning" className="location-policy-alert">
              <ShieldAlert aria-hidden className="alert-leading-icon" />
              <div>
                <AlertTitle>Location accuracy is too low for live corroboration</AlertTitle>
                <AlertDescription>
                  The ±{Math.round(location.accuracy)} m reading will be preserved with this report. It does not
                  qualify for live community corroboration unless accuracy is 100 m or better, but responders may
                  still review it.
                </AlertDescription>
              </div>
            </Alert>
          ) : null}

          {!runtime.incidentId ? (
            <Alert variant="warning" className="location-policy-alert">
              <ShieldAlert aria-hidden className="alert-leading-icon" />
              <div>
                <AlertTitle>Live incident context unavailable</AlertTitle>
                <AlertDescription>
                  This offline session has no verified authority incident. The form cannot create or queue a live report.
                </AlertDescription>
              </div>
            </Alert>
          ) : null}

          <Controller
            name="waterDepth"
            control={control}
            render={({ field }) => (
              <FieldSet>
                <FieldLegend>Water depth <span className="legend-qualifier">(approx.)</span></FieldLegend>
                <ToggleGroup
                  type="single"
                  value={field.value}
                  onValueChange={(value) => value && field.onChange(value)}
                  className="depth-grid"
                  aria-label="Approximate water depth"
                >
                  {depthOptions.map(({ value, title, detail, icon: Icon }) => (
                    <ToggleGroupItem key={value} value={value} className="choice-tile">
                      <Icon aria-hidden />
                      <span><strong>{title}</strong><small>{detail}</small></span>
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </FieldSet>
            )}
          />

          <Controller
            name="roadStatus"
            control={control}
            render={({ field }) => (
              <FieldSet>
                <FieldLegend>Road status</FieldLegend>
                <ToggleGroup
                  type="single"
                  value={field.value}
                  onValueChange={(value) => value && field.onChange(value)}
                  className="road-grid"
                  aria-label="Road status"
                >
                  {roadOptions.map(({ value, title, icon: Icon }) => (
                    <ToggleGroupItem key={value} value={value} className="choice-tile compact-choice" aria-label={title}>
                      <Icon aria-hidden /><strong>{title}</strong>
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </FieldSet>
            )}
          />

          <Controller
            name="infrastructureIssues"
            control={control}
            render={({ field }) => (
              <FieldSet>
                <FieldLegend>Infrastructure issues <span className="legend-qualifier">(select all that apply)</span></FieldLegend>
                <div className="issues-grid">
                  {issueOptions.map(({ value, title, icon: Icon }) => {
                    const selected = field.value.includes(value);
                    return (
                      <button
                        key={value}
                        type="button"
                        className="issue-choice"
                        data-selected={selected || undefined}
                        aria-pressed={selected}
                        onClick={() => field.onChange(selected ? field.value.filter((item) => item !== value) : [...field.value, value])}
                      >
                        <span className="issue-check" aria-hidden>{selected ? <Check /> : null}</span>
                        <Icon aria-hidden />
                        <span>{title}</span>
                      </button>
                    );
                  })}
                </div>
              </FieldSet>
            )}
          />

          <FieldSet>
            <FieldLegend>Evidence <span className="legend-qualifier">(photo is optional)</span></FieldLegend>
            <div className="photo-row">
              {previewUrl ? (
                <div className="photo-preview">
                  <img src={previewUrl} alt="Selected flood evidence preview" />
                  <button type="button" onClick={removePhoto} aria-label="Remove selected photo"><X aria-hidden /></button>
                </div>
              ) : null}
              <label className="photo-picker" htmlFor={fileInputId}>
                <Camera aria-hidden />
                <span>{previewUrl ? "Change photo" : "Add photo"}</span>
                <input
                  id={fileInputId}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(event) => void onPhotoChange(event.currentTarget.files?.[0])}
                />
              </label>
            </div>
            <FieldDescription className="privacy-caption">
              <LockKeyhole aria-hidden />We minimize metadata. No faces or license plates should be visible.
            </FieldDescription>
          </FieldSet>

          <label className="note-field">
            <span>Add a short note</span>
            <Textarea
              {...register("note")}
              placeholder="What changed, and what are people doing?"
              aria-invalid={Boolean(errors.note)}
              maxLength={250}
            />
            <small>{note.length} / 250</small>
            {errors.note ? <span className="field-error">{errors.note.message}</span> : null}
          </label>

          <p className="safety-line"><ShieldAlert aria-hidden />Do not enter floodwater to submit a report.</p>

          <div className="form-submit-region">
            <Alert variant="info" className="identity-notice">
              <Info aria-hidden className="alert-leading-icon" />
              <div>
                <AlertTitle>A device-generated report ID supports independence checks.</AlertTitle>
                <AlertDescription>Your identity remains hidden from public views.</AlertDescription>
              </div>
            </Alert>

            {formError ? <Alert variant="destructive"><AlertDescription>{formError}</AlertDescription></Alert> : null}
            {savedOffline ? <Alert variant="info"><AlertDescription>Report saved in the encrypted offline queue.</AlertDescription></Alert> : null}

            <Button
              type="submit"
              size="lg"
              className="submit-report-button"
              disabled={isSubmitting || !runtime.incidentId || !location}
            >
              {isSubmitting ? <RefreshCw aria-hidden className="spin" /> : isOnline ? <CloudUpload aria-hidden /> : <CloudUpload aria-hidden />}
              <span>
                <strong>{isSubmitting ? "Saving report…" : isOnline ? "Submit report" : "Save report offline"}</strong>
                <small>{queue.count ? `${queue.count} ${queue.count === 1 ? "report" : "reports"} waiting` : isOnline ? "Uses an idempotent report ID" : "Syncs automatically after reconnecting"}</small>
              </span>
            </Button>
            <p className="auto-sync-copy"><RefreshCw aria-hidden />Submit when online automatically</p>
          </div>
        </form>
      </section>
    </div>
  );
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Photo could not be read."));
    reader.readAsDataURL(file);
  });
}
