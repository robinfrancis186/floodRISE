import {
  createContext,
  type PropsWithChildren,
  useContext,
} from "react";
import {
  DEMO_FIELD_RUNTIME,
  type FieldRuntime,
} from "./field-runtime";

export type FieldCloudAccess =
  | { mode: "full"; runtime: FieldRuntime; retry?: undefined }
  | { mode: "offline_only"; runtime: FieldRuntime; retry: () => void };

const FieldCloudAccessContext = createContext<FieldCloudAccess>({
  mode: "full",
  runtime: DEMO_FIELD_RUNTIME,
});

export function FieldCloudAccessProvider({
  access,
  children,
}: PropsWithChildren<{ access: FieldCloudAccess }>) {
  return (
    <FieldCloudAccessContext.Provider value={access}>
      {children}
    </FieldCloudAccessContext.Provider>
  );
}

export function useFieldCloudAccess() {
  return useContext(FieldCloudAccessContext);
}
