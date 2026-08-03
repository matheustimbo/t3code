import { useCallback, useEffect, useState } from "react";

import { isElectron } from "../env";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import {
  canCheckForUpdate,
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { stackedThreadToast, toastManager } from "./ui/toast";

function downloadDesktopUpdate(): void {
  const bridge = window.desktopBridge;
  if (!bridge) return;
  void bridge
    .downloadUpdate()
    .then((result) => {
      if (result.completed) {
        toastManager.add({
          type: "success",
          title: "Update downloaded",
          description: "Restart the app from the update button to install it.",
        });
      }
      if (!shouldToastDesktopUpdateActionResult(result)) return;
      const actionError = getDesktopUpdateActionError(result);
      if (!actionError) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not download update",
          description: actionError,
        }),
      );
    })
    .catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start update download",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    });
}

/**
 * Call-to-action when this client is behind the connected server. On desktop,
 * drives the Electron updater (check → download → install). Elsewhere, only
 * guidance text is shown — there is no server-install path for this case.
 *
 * After `checkForUpdate`, desktop state is applied asynchronously via updater
 * events. We ignore the pre-check snapshot and only continue once `checkedAt`
 * advances (or status becomes `checking`) and then settles to a terminal status.
 */
export function ClientUpdateAction({ label = "Update client" }: { readonly label?: string }) {
  const updateState = useDesktopUpdateState();
  const [pendingCheck, setPendingCheck] = useState<{
    readonly baselineCheckedAt: string | null;
  } | null>(null);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const checking = updateState?.status === "checking" || pendingCheck !== null;
  const downloading = updateState?.status === "downloading";
  const updatesDisabled =
    updateState !== null && (!updateState.enabled || updateState.status === "disabled");
  const buttonDisabled =
    checking ||
    downloading ||
    (action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState));

  const buttonLabel =
    action === "install"
      ? "Restart to update"
      : action === "download"
        ? label
        : downloading
          ? typeof updateState?.downloadPercent === "number"
            ? `Downloading (${Math.floor(updateState.downloadPercent)}%)`
            : "Downloading…"
          : checking
            ? "Checking…"
            : label;

  useEffect(() => {
    if (!pendingCheck || !updateState) {
      return;
    }

    const checkAdvanced =
      updateState.status === "checking" || updateState.checkedAt !== pendingCheck.baselineCheckedAt;
    if (!checkAdvanced) {
      // Still looking at the pre-click snapshot; wait for desktop to publish
      // check-start / check-result state.
      return;
    }
    if (updateState.status === "checking") {
      return;
    }

    setPendingCheck(null);

    const nextAction = resolveDesktopUpdateButtonAction(updateState);
    if (nextAction === "download") {
      downloadDesktopUpdate();
      return;
    }
    if (nextAction === "install") {
      return;
    }
    if (updateState.status === "up-to-date") {
      toastManager.add({
        type: "info",
        title: "No newer desktop update found",
        description:
          "This build may not have a published update yet. Install a newer T3 Code desktop build to match the server.",
      });
      return;
    }
    if (updateState.status === "error") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not check for updates",
          description: updateState.message ?? "Update check failed.",
        }),
      );
    }
  }, [pendingCheck, updateState]);

  const handleClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    if (action === "download") {
      downloadDesktopUpdate();
      return;
    }

    if (action === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(
          updateState ?? { availableVersion: null, downloadedVersion: null },
          navigator.platform,
        ),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: actionError,
            }),
          );
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        });
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    setPendingCheck({ baselineCheckedAt: updateState?.checkedAt ?? null });
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (!result.checked) {
          setPendingCheck(null);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check for updates",
              description:
                result.state.message ?? "Automatic updates are not available in this build.",
            }),
          );
        }
        // Do not download from result.state here — updater events may still be
        // in flight. The effect above continues once desktop update state settles.
      })
      .catch((error: unknown) => {
        setPendingCheck(null);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      });
  }, [action, updateState]);

  if (!isElectron) {
    return (
      <span className="text-muted-foreground text-xs">
        Update or reload this client to match the server.
      </span>
    );
  }

  if (updatesDisabled) {
    return (
      <span className="text-muted-foreground text-xs">
        Automatic updates are unavailable in this build. Install a newer T3 Code desktop build to
        match the server.
      </span>
    );
  }

  return (
    <Button size="xs" disabled={buttonDisabled} onClick={handleClick}>
      {checking || downloading ? <Spinner className="size-3.5" /> : null}
      {buttonLabel}
    </Button>
  );
}
