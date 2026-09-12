import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const stageArtworkState = vi.hoisted(() => ({
  mode: "none" as "artwork" | "none",
  variant: null as "nightly" | "dev" | null,
}));

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => stageArtworkState.mode,
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: ({ variant }: { variant: string }) => `stage-${variant}`,
  useSidebarStageBackdropVariant: (enabled = true) => (enabled ? stageArtworkState.variant : null),
}));

import { resolveSendWhileRunning } from "@t3tools/client-runtime/composer/send-while-running";
import type { SendWhileRunningAffordance } from "@t3tools/client-runtime/composer/send-while-running";

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

function renderPendingActions(isRunning: boolean) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
      isRunning,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderRunningActions(input: {
  sendWhileRunning: SendWhileRunningAffordance | null;
  hasSendableContent: boolean;
  compact?: boolean;
  showEnterHint?: boolean;
}) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: input.compact ?? true,
      pendingAction: null,
      isRunning: true,
      showPlanFollowUpPrompt: false,
      promptHasText: input.hasSendableContent,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: input.hasSendableContent,
      sendWhileRunning: input.sendWhileRunning,
      showEnterHint: input.showEnterHint ?? false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderSendButton(sendDisabledReason: string | null = null) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: false,
      showPlanFollowUpPrompt: false,
      promptHasText: true,
      isSendBusy: false,
      sendDisabledReason,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: true,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

const steerAffordance = resolveSendWhileRunning({
  isRunning: true,
  provider: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    concurrentSend: "steer",
  },
})!;

const unsupportedAffordance = resolveSendWhileRunning({
  isRunning: true,
  provider: {
    instanceId: ProviderInstanceId.make("cursor"),
    driver: ProviderDriverKind.make("cursor"),
    concurrentSend: "unsupported",
  },
})!;

afterEach(() => {
  stageArtworkState.mode = "none";
  stageArtworkState.variant = null;
});

describe("ComposerPrimaryActions", () => {
  it("disables and labels the send button while feedback is uploading", () => {
    const markup = renderSendButton("Sending feedback");

    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-label="Sending feedback"');
  });

  it("offers Stop generation while a running turn is waiting for user input", () => {
    expect(renderPendingActions(true)).toContain('aria-label="Stop generation"');
  });

  it("does not offer Stop generation for a pending request without a running turn", () => {
    expect(renderPendingActions(false)).not.toContain('aria-label="Stop generation"');
  });

  it("renders stage artwork inside the send button when artwork identification is active", () => {
    stageArtworkState.mode = "artwork";
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).toContain("stage-nightly");
  });

  it("hides stage artwork when artwork identification is inactive", () => {
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).not.toContain("stage-nightly");
  });

  it("names what a second send does, on the button face, alongside stop", () => {
    const markup = renderRunningActions({
      sendWhileRunning: steerAffordance,
      hasSendableContent: true,
      compact: false,
      showEnterHint: true,
    });

    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).toContain("Steer");
    expect(markup).toContain('type="submit"');
  });

  it("carries the label in the accessible name when the composer is narrow", () => {
    const markup = renderRunningActions({
      sendWhileRunning: steerAffordance,
      hasSendableContent: true,
    });

    expect(markup).toContain('aria-label="Steer"');
    expect(markup).not.toContain(">Steer<");
  });

  it("disables the action and says why when the provider cannot take a send", () => {
    const markup = renderRunningActions({
      sendWhileRunning: unsupportedAffordance,
      hasSendableContent: true,
    });

    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-label="Cursor cannot take a message while it is working."');
  });

  it("keeps stop as the only action while running with an empty composer", () => {
    const markup = renderRunningActions({
      sendWhileRunning: steerAffordance,
      hasSendableContent: false,
    });

    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).not.toContain("Steer");
  });

  it("keeps stop as the only action when no affordance is resolved", () => {
    const markup = renderRunningActions({ sendWhileRunning: null, hasSendableContent: true });

    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).not.toContain('type="submit"');
  });
});
