import {
  resolveProviderSkillSourceKind,
  type ProviderSkillSourceKind,
} from "@t3tools/client-runtime/providerSkills";
import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import type { ComposerTriggerKind } from "@t3tools/shared/composerTrigger";
import { memo } from "react";
import { Pressable, ScrollView, StyleSheet, View, type ViewStyle } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { GlassSurface } from "../../components/GlassSurface";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
export type ComposerCommandItem =
  | {
      readonly id: string;
      readonly type: "path";
      readonly path: string;
      readonly kind: "file" | "directory";
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "slash-command";
      readonly command: string;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "provider-slash-command";
      readonly command: ServerProviderSlashCommand;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "skill";
      readonly skill: ServerProviderSkill;
      readonly label: string;
      readonly description: string;
    };

export type ComposerPinnableItem = Extract<
  ComposerCommandItem,
  { type: "skill" | "provider-slash-command" }
>;

/**
 * Whether a row names a provider entry point a mode can repeat. Skills qualify,
 * and so do provider slash commands, because Claude Code lists plugin skills
 * only under `/`. The client's own `/model` and a path do not.
 */
export function isComposerPinnableItem(item: ComposerCommandItem): item is ComposerPinnableItem {
  return item.type === "skill" || item.type === "provider-slash-command";
}

interface ComposerCommandPopoverProps {
  readonly items: ReadonlyArray<ComposerCommandItem>;
  readonly triggerKind: ComposerTriggerKind | null;
  readonly isLoading: boolean;
  readonly onSelect: (item: ComposerCommandItem) => void;
  readonly onPinMode?: (item: ComposerPinnableItem) => void;
}

function PopoverSurface(props: { readonly children: React.ReactNode; readonly style?: ViewStyle }) {
  const baseStyle: ViewStyle = {
    borderRadius: 16,
    overflow: "hidden",
    ...props.style,
  };

  return (
    <GlassSurface
      glassEffectStyle="clear"
      tintColorClassName="accent-glass-surface"
      style={baseStyle}
    >
      {props.children}
    </GlassSurface>
  );
}

const SKILL_SOURCE_SYMBOL_BY_KIND: Record<ProviderSkillSourceKind, AppSymbolName> = {
  app: "square.grid.2x2",
  repo: "folder",
  project: "folder",
  personal: "person.crop.circle",
  system: "gearshape",
  other: "cube",
};

function itemIcon(item: ComposerCommandItem): AppSymbolName | null {
  switch (item.type) {
    case "slash-command":
    case "provider-slash-command":
      return "terminal";
    case "skill":
      return SKILL_SOURCE_SYMBOL_BY_KIND[resolveProviderSkillSourceKind(item.skill)];
    case "path":
      return null;
  }
}

function groupLabel(triggerKind: ComposerTriggerKind | null): string | null {
  switch (triggerKind) {
    case "slash-command":
      return "Commands";
    case "skill":
      return "Skills";
    case "path":
      return "Files";
    default:
      return null;
  }
}

function emptyText(triggerKind: ComposerTriggerKind | null, isLoading: boolean): string {
  if (isLoading) {
    return triggerKind === "path" ? "Searching files…" : "Loading…";
  }
  switch (triggerKind) {
    case "path":
      return "No matching files or folders.";
    case "skill":
      return "No skills found.";
    case "slash-command":
      return "No matching commands.";
    default:
      return "No results.";
  }
}

const CommandRow = memo(function CommandRow(props: {
  readonly item: ComposerCommandItem;
  readonly onPress: () => void;
  readonly onPinMode?: () => void;
  readonly isLast: boolean;
  readonly isSlashSkill: boolean;
}) {
  const iconName = itemIcon(props.item);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className="flex-row items-center gap-2.5 border-border px-3.5 py-2.5 active:opacity-60"
      style={{ borderBottomWidth: props.isLast ? 0 : StyleSheet.hairlineWidth }}
    >
      {props.item.type === "path" ? (
        <PierreEntryIcon path={props.item.path} kind={props.item.kind} size={16} />
      ) : iconName ? (
        <SymbolView
          name={iconName}
          size={14}
          tintColorClassName={"accent-icon-subtle"}
          type="monochrome"
        />
      ) : null}
      <Text className="shrink-0 text-base font-t3-medium text-foreground" numberOfLines={1}>
        {props.isSlashSkill && props.item.type === "skill" ? (
          <>
            <Text className="text-foreground-muted">skill:</Text>
            {props.item.skill.name}
          </>
        ) : (
          props.item.label
        )}
      </Text>
      {props.item.description ? (
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          {props.item.description}
        </Text>
      ) : null}
      {props.onPinMode ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Use ${props.item.label} as a mode`}
          accessibilityHint="Starts every message in this thread with it"
          // The row is the outer press target, so the pill has to claim the
          // touch before it bubbles or tapping Mode would insert instead.
          onPress={(event) => {
            event.stopPropagation();
            props.onPinMode?.();
          }}
          hitSlop={8}
          className="ml-auto shrink-0 rounded-md bg-subtle px-2 py-1 active:opacity-60"
        >
          <Text className="text-2xs font-t3-medium text-foreground-muted">Mode</Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
});

export const ComposerCommandPopover = memo(function ComposerCommandPopover(
  props: ComposerCommandPopoverProps,
) {
  const label = groupLabel(props.triggerKind);

  return (
    <PopoverSurface>
      {label ? (
        <View className="px-3.5 pt-2.5 pb-1">
          <Text className="text-3xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted">
            {label}
          </Text>
        </View>
      ) : null}
      {props.items.length > 0 ? (
        <ScrollView
          className="max-h-[180px]"
          keyboardShouldPersistTaps="always"
          showsVerticalScrollIndicator={false}
        >
          {props.items.map((item, index) => {
            const onPinMode = props.onPinMode;
            return (
              <CommandRow
                key={item.id}
                item={item}
                onPress={() => props.onSelect(item)}
                {...(onPinMode && isComposerPinnableItem(item)
                  ? { onPinMode: () => onPinMode(item) }
                  : {})}
                isLast={index === props.items.length - 1}
                isSlashSkill={props.triggerKind === "slash-command" && item.type === "skill"}
              />
            );
          })}
        </ScrollView>
      ) : (
        <View className="px-3.5 py-2.5">
          <Text className="text-xs text-foreground-tertiary">
            {emptyText(props.triggerKind, props.isLoading)}
          </Text>
        </View>
      )}
    </PopoverSurface>
  );
});
