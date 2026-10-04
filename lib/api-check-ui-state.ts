export const apiCheckSuccessFeedbackMs = 3000;

export type ApiCheckUiState = {
  phase: "idle" | "checking" | "complete" | "error";
  downloadable: boolean;
  error: string | null;
};

export type ApiCheckUiEvent =
  | { type: "start" }
  | { type: "report_generated" }
  | { type: "feedback_elapsed" }
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
    case "feedback_elapsed":
      return state.phase === "complete"
        ? { phase: "idle", downloadable: true, error: null }
        : state;
    case "failed":
      return { phase: "error", downloadable: false, error: event.error };
  }
}
