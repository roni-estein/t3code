import { memo } from "react";
import { TriangleAlertIcon } from "lucide-react";

import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { deriveContextWindowWarning } from "./ContextWindowWarningBanner.logic";

/**
 * Proactive prompt for the user to run `/compact` before Claude's context
 * window saturates. Separated from `ContextWindowMeter` (the always-on
 * dial in the composer) because that meter is a passive indicator; this
 * banner is an active nudge that only appears when we're close to the
 * edge so the `/recover-thread` DB-replay fallback stays useful.
 *
 * All decision logic lives in `./ContextWindowWarningBanner.logic` so it
 * can be unit tested without rendering the Alert.
 */
export const ContextWindowWarningBanner = memo(function ContextWindowWarningBanner({
  usage,
}: {
  usage: ContextWindowSnapshot | null;
}) {
  const viewModel = deriveContextWindowWarning(usage);
  if (!viewModel) return null;

  const remainingLabel =
    viewModel.remainingTokens !== null
      ? `${formatContextWindowTokens(viewModel.remainingTokens)} tokens left`
      : null;

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant="warning">
        <TriangleAlertIcon />
        <AlertTitle>Context window is {viewModel.usedPercentageRounded}% full</AlertTitle>
        <AlertDescription>
          Run <code className="font-mono text-xs">/compact</code> to summarise earlier messages
          before Claude auto-compacts (which loses fidelity) or the window saturates.
          {remainingLabel ? ` ${remainingLabel}.` : null}
        </AlertDescription>
      </Alert>
    </div>
  );
});
