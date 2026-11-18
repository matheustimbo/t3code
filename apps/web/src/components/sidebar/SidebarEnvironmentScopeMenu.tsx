import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { NetworkIcon } from "lucide-react";

import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

const ALL_MACHINES = "all";

export function SidebarEnvironmentScopeMenu(props: {
  readonly environmentLabelById: ReadonlyMap<EnvironmentId, string>;
  readonly machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
  readonly value: EnvironmentId | null;
  readonly onChange: (environmentId: EnvironmentId | null) => void;
}) {
  const gt = useGT();
  const environments = [...props.environmentLabelById];
  const selectedLabel = props.value === null ? null : props.environmentLabelById.get(props.value);
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            label={
              selectedLabel
                ? gt("Filter threads by machine: {machine}", { machine: selectedLabel })
                : gt("Filter threads by machine")
            }
          />
        }
      >
        {props.value === null ? (
          <NetworkIcon className="size-4" />
        ) : (
          <EnvironmentMachineIcon
            kind={props.machineByEnvironmentId.get(props.value) ?? "server"}
            className="size-4"
          />
        )}
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuRadioGroup
          value={props.value ?? ALL_MACHINES}
          onValueChange={(next) => {
            if (typeof next !== "string") return;
            props.onChange(
              environments.find(([environmentId]) => environmentId === next)?.[0] ?? null,
            );
          }}
        >
          <MenuRadioItem value={ALL_MACHINES} closeOnClick>
            <span className="flex min-w-0 items-center gap-2">
              <NetworkIcon aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{gt("All machines")}</span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
          <MenuSeparator />
          {environments.map(([environmentId, label]) => (
            <MenuRadioItem key={environmentId} value={environmentId} closeOnClick>
              <span className="flex min-w-0 items-center gap-2">
                <EnvironmentMachineIcon
                  aria-hidden
                  kind={props.machineByEnvironmentId.get(environmentId) ?? "server"}
                  className="size-4 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
