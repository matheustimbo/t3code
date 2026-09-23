import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { useEnvironmentOperateAccess } from "./EnvironmentIconPicker";

/**
 * Why the name is fixed, in the order the user can do something about it.
 * Null means it can be changed.
 */
export function resolveEnvironmentRenameLock(input: {
  readonly serverConfig: ServerConfig | null;
  readonly operateAccess: "granted" | "denied" | "pending";
}): string | null {
  if (input.serverConfig === null) {
    return "Connect to this environment to rename it.";
  }
  if (input.serverConfig.environment.capabilities.environmentRename !== true) {
    return "This environment's server is too old to keep a name. Update it to rename this machine.";
  }
  if (input.operateAccess === "denied") {
    return "Your session on this environment cannot change its settings.";
  }
  return null;
}

/**
 * Renames one machine for every client connected to it. The name is stored on
 * that machine, not on this device, so it is the same name on the phone and in
 * a browser somewhere else. Clearing it goes back to the name the machine's
 * own OS reports.
 */
export function EnvironmentRenameDialog({
  environmentId,
  serverConfig,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: ServerConfig | null;
  readonly onClose: () => void;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const operateAccess = useEnvironmentOperateAccess(environmentId);
  const lock = resolveEnvironmentRenameLock({ serverConfig, operateAccess });
  const [draft, setDraft] = useState(
    serverConfig?.settings.environmentLabel || serverConfig?.environment.label || "",
  );
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup
        render={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (lock !== null) return;
              updateSettings({ environmentLabel: draft.trim() });
              onClose();
            }}
          />
        }
      >
        <DialogHeader>
          <DialogTitle>Rename this machine</DialogTitle>
          <DialogDescription>
            {lock ??
              "Every client connected to this machine sees the new name. Clear the field to go back to the name the machine reports."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="block space-y-1.5 text-sm">
            <span>Name</span>
            <Input
              autoFocus
              value={draft}
              disabled={lock !== null}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Mac mini"
            />
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={lock !== null}>
            Save name
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
