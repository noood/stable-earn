export const apiCheckSuccessFeedbackMs = 3000;

export type ApiCheckUiState = {
  phase: "idle" | "checking" | "complete" | "error";
  downloadable: boolean;
  error: string | null;
};

export type ApiCheckUiEvent =
  | { type: "start" }
  | { type: "report_generated" }
  | { type: "partial_report" }
  | { type: "feedback_elapsed" }
  | { type: "rate_limited" }
  | { type: "failed"; error: string };

export const initialApiCheckUiState: ApiCheckUiState = {
  phase: "idle",
  downloadable: false,
  error: null,
};

export function transitionApiCheckUiState(state: ApiCheckUiState, event: ApiCheckUiEvent): ApiCheckUiState {
  switch (event.type) {
    case "start":
      return { phase: "checking", downloadable: false, error: null };
    case "report_generated":
      return state.phase === "checking"
        ? { phase: "complete", downloadable: true, error: null }
        : state;
    case "partial_report":
      return { phase: "idle", downloadable: false, error: null };
    case "feedback_elapsed":
      return state.phase === "complete"
        ? { phase: "idle", downloadable: true, error: null }
        : state;
    case "rate_limited":
      return { phase: "idle", downloadable: false, error: null };
    case "failed":
      return { phase: "error", downloadable: false, error: event.error };
  }
}

export function parseRetryAfterSeconds(value: string | null) {
  if (value === null) return 60;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : 60;
}

export function formatRetryWait(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}
