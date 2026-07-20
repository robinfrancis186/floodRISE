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
import { DEMO_INCIDENT_ID, DEMO_SCENARIO_TIME } from "../data/demo";
import { useNetworkStatus } from "../hooks/useNetworkStatus";
import { useQueueSummary } from "../hooks/useQueueSummary";
import { ReportSubmissionError, shouldRetrySubmission, submitReport } from "../lib/api";
import { enqueueReport, saveReceipt, type OfflineReportDraft, type PhotoDraft } from "../lib/db";
import { createClientReportId, getDeviceId, getReporterId } from "../lib/identity";
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
  latitude: 12.9791,
  longitude: 80.2209,
  accuracy: 12,
  label: "Velachery Main Road"
};

export function ReportFloodingPage() {
  const navigate = useNavigate();
  const { isOnline } = useNetworkStatus();
  const queue = useQueueSummary();
  const fileInputId = useId();
  const [location, setLocation] = useState(demoLocation);
  const [locating, setLocating] = useState(false);
  const [photo, setPhoto] = useState<PhotoDraft | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedOffline, setSavedOffline] = useState(false);

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
          accuracy: Math.round(position.coords.accuracy),
          label: "Current location"
        });
        setLocating(false);
        setFormError(null);
      },
      () => {
        setFormError("Location permission was not available. The Velachery demo pin is still selected.");
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
    const clientId = createClientReportId();
    const draft: OfflineReportDraft = {
      client_report_id: clientId,
      incident_id: DEMO_INCIDENT_ID,
      reporter_id: getReporterId(),
      device_id: getDeviceId(),
      observed_at: import.meta.env.VITE_DEMO_MODE === "false" ? new Date().toISOString() : DEMO_SCENARIO_TIME,
      location: {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy_m: Math.min(location.accuracy, 100)
      },
      water_depth: values.waterDepth,
      road_status: values.roadStatus,
      infrastructure_issues: values.infrastructureIssues,
      note: values.note || undefined,
      place_label: location.label,
      photo: photo ?? undefined
    };

    try {
      if (!isOnline) {
        await enqueueReport(draft);
        setSavedOffline(true);
        await navigate({ to: "/queue" });
        return;
      }
      const receipt = await submitReport(draft);
      await saveReceipt(receipt);
      await navigate({ to: "/receipt/$receiptId", params: { receiptId: receipt.id } });
    } catch (error) {
      if (isOnline && shouldRetrySubmission(error)) {
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
          return;
        } catch (queueError) {
          setFormError(queueError instanceof Error ? queueError.message : "Report could not be stored offline.");
          return;
        }
      }
      setFormError(error instanceof Error ? error.message : "Report could not be submitted.");
    }
  }

  return (
    <div className="page report-page">
      <section className="report-map" aria-label="Selected report location">
        <FloodMap variant="field" horizon="3h" height={470} showSummary={false} ariaLabel="Flood conditions around selected report pin" />
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
              <strong>{location.label}</strong>
              <span>±{Math.round(location.accuracy)} m accuracy</span>
            </div>
            <Button type="button" variant="link" onClick={() => void useCurrentLocation()} disabled={locating}>
              {locating ? "Locating…" : "Adjust pin"}<ChevronRight aria-hidden />
            </Button>
          </div>

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

            <Button type="submit" size="lg" className="submit-report-button" disabled={isSubmitting}>
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
