import type { EnvironmentId, RecoveryOutcome, ThreadId } from "@t3tools/contracts";
import { CheckIcon, CircleAlertIcon, MinusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { ensureEnvironmentApi } from "~/environmentApi";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Spinner } from "./ui/spinner";
import {
  applyRecoveryProgressEvent,
  initialRecoveryOverlayViewModel,
  type RecoveryOverlayViewModel,
  type RecoveryStepView,
  summarizeRecoveryOutcome,
} from "./RecoveryProgressOverlay.logic";

/**
 * RecoveryProgressOverlay — modal visualising the server-side 5-step
 * recovery waterfall.
 *
 * Consumers pass an `environmentId` + `threadId` + `cwd` and toggle the
 * dialog with `open`. On open the overlay fires
 * `threadRecovery.recover(...)` against the environment RPC surface and
 * folds the streamed `RecoveryProgressEvent`s into its internal
 * view-model. When the terminal `completed` event arrives, `onOutcome`
 * is invoked with the final `RecoveryOutcome` so the caller can drive
 * next steps (resume the thread, seed a replay transcript, surface an
 * error, etc.).
 *
 * The overlay keeps itself open after the outcome arrives so the user
 * can read the waterfall result. Close/confirm is always an explicit
 * user action (no auto-dismiss) — this matches the promise we made
 * around "testable and observable recovery" in the PR design notes.
 *
 * @see apps/server/src/provider/Services/ThreadRecovery.ts
 * @see packages/contracts/src/threadRecovery.ts
 * @see apps/web/src/components/RecoveryProgressOverlay.logic.ts
 */

export interface RecoveryProgressOverlayProps {
  /** Controls visibility. Parent owns dialog state. */
  readonly open: boolean;
  /** Which environment connection to invoke the RPC on. */
  readonly environmentId: EnvironmentId;
  /** The thread we're trying to recover. */
  readonly threadId: ThreadId;
  /** Workspace root — the server encodes this for JSONL lookup. */
  readonly cwd: string;
  /** Invoked when the user asks to dismiss the dialog. */
  readonly onOpenChange: (next: boolean) => void;
  /**
   * Invoked once when the terminal `completed` event arrives. Caller
   * decides what to do with the outcome (seed transcript, resume, etc.).
   */
  readonly onOutcome?: (outcome: RecoveryOutcome) => void;
}

type Action =
  | {
      readonly type: "event";
      readonly payload: Parameters<typeof applyRecoveryProgressEvent>[1];
    }
  | { readonly type: "reset" }
  | { readonly type: "error"; readonly message: string };

interface ReducerState {
  readonly model: RecoveryOverlayViewModel;
  readonly transportError: string | null;
}

const INITIAL_STATE: ReducerState = {
  model: initialRecoveryOverlayViewModel,
  transportError: null,
};

function reducer(state: ReducerState, action: Action): ReducerState {
  switch (action.type) {
    case "event":
      return {
        model: applyRecoveryProgressEvent(state.model, action.payload),
        transportError: null,
      };
    case "reset":
      return INITIAL_STATE;
    case "error":
      return { ...state, transportError: action.message };
    default: {
      const _exhaustive: never = action;
      return state;
    }
  }
}

export function RecoveryProgressOverlay({
  open,
  environmentId,
  threadId,
  cwd,
  onOpenChange,
  onOutcome,
}: RecoveryProgressOverlayProps) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const [isInFlight, setIsInFlight] = useState(false);
  const lastOutcomeRef = useRef<RecoveryOutcome | null>(null);

  const kickoff = useCallback(async () => {
    dispatch({ type: "reset" });
    lastOutcomeRef.current = null;
    setIsInFlight(true);

    try {
      const api = ensureEnvironmentApi(environmentId);
      const outcome = await api.threadRecovery.recover(
        { threadId, cwd },
        {
          onProgress: (event) => {
            dispatch({ type: "event", payload: event });
          },
        },
      );
      lastOutcomeRef.current = outcome;
      onOutcome?.(outcome);
    } catch (error) {
      dispatch({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsInFlight(false);
    }
  }, [environmentId, threadId, cwd, onOutcome]);

  // Kick off automatically on open. A parent that needs manual control
  // can toggle `open` → false → true to re-run.
  useEffect(() => {
    if (open) {
      void kickoff();
    } else {
      dispatch({ type: "reset" });
      setIsInFlight(false);
      lastOutcomeRef.current = null;
    }
  }, [open, kickoff]);

  const footerCopy = useMemo(() => {
    if (state.transportError) {
      return `Recovery stream failed: ${state.transportError}`;
    }
    if (state.model.outcome) {
      return summarizeRecoveryOutcome(state.model.outcome);
    }
    if (state.model.phase === "running") {
      return "Walking the waterfall…";
    }
    return "Preparing to inspect this thread's Claude session.";
  }, [state.model.outcome, state.model.phase, state.transportError]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!isInFlight) {
          onOpenChange(next);
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Recover Claude thread</DialogTitle>
          <DialogDescription>
            The saved Claude session for this thread couldn't be resumed. Running a five-step
            waterfall to find or rebuild it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <ul className="space-y-2">
            {state.model.steps.map((step) => (
              <RecoveryStepRow key={step.step} entry={step} />
            ))}
          </ul>
          <p
            className={cn(
              "text-xs",
              state.transportError ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {footerCopy}
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void kickoff();
            }}
            disabled={isInFlight}
          >
            Retry waterfall
          </Button>
          <Button type="button" size="sm" onClick={() => onOpenChange(false)} disabled={isInFlight}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RecoveryStepRow({ entry }: { entry: RecoveryStepView }) {
  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-lg border px-3 py-2 text-sm",
        entry.status === "running" && "border-primary/40 bg-primary/4",
        entry.status === "failed" && "border-destructive/40 bg-destructive/4",
        entry.status === "succeeded" && "border-emerald-500/40 bg-emerald-500/4",
        entry.status === "skipped" && "border-border/60 bg-muted/40 text-muted-foreground",
        entry.status === "pending" && "border-border/40 bg-muted/12",
      )}
      data-status={entry.status}
      data-step={entry.step}
    >
      <RecoveryStepIcon status={entry.status} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{entry.label}</p>
        {entry.detail ? (
          <p className="mt-0.5 line-clamp-2 break-all text-muted-foreground text-xs">
            {entry.detail}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function RecoveryStepIcon({ status }: { status: RecoveryStepView["status"] }) {
  switch (status) {
    case "running":
      return <Spinner className="mt-0.5 size-4 shrink-0 text-primary" />;
    case "succeeded":
      return <CheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-500" />;
    case "skipped":
      return <MinusIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
    case "failed":
      return <XIcon className="mt-0.5 size-4 shrink-0 text-destructive" />;
    case "pending":
    default:
      return <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/40" />;
  }
}
