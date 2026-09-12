import { composerSkillModeMention, type ComposerSkillMode } from "@t3tools/shared/composerTrigger";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "./AppSymbol";
import { AppText as Text } from "./AppText";

/**
 * Sits above the editor rather than in the toolbar, which is hidden while the
 * composer is collapsed. A pinned mode that vanishes on collapse would be a
 * setting the user cannot see or undo.
 */
export const ComposerSkillModeChip = memo(function ComposerSkillModeChip(props: {
  readonly skillMode: ComposerSkillMode;
  readonly onRemove: () => void;
}) {
  return (
    <View className="flex-row">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove pinned mode ${props.skillMode.label}`}
        accessibilityHint={`Every message starts with ${composerSkillModeMention(props.skillMode)}`}
        onPress={props.onRemove}
        hitSlop={6}
        className="max-w-full flex-row items-center gap-1.5 rounded-lg bg-subtle px-2 py-1 active:opacity-60"
      >
        <SymbolView
          name="cube"
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        <Text className="shrink text-xs font-t3-medium text-foreground-muted" numberOfLines={1}>
          {props.skillMode.label}
        </Text>
        <SymbolView
          name="xmark"
          size={10}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
      </Pressable>
    </View>
  );
});
